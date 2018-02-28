/* Copyright (C) 2017 Tierion
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// load all environment variables into env object
const env = require('./lib/parse-env.js')('audit')

const registeredNode = require('./lib/models/RegisteredNode.js')
const utils = require('./lib/utils.js')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const cachedAuditChallenge = require('./lib/models/cachedAuditChallenge.js')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const crypto = require('crypto')
const rnd = require('random-number-csprng')
const MerkleTools = require('merkle-tools')
const heartbeats = require('heartbeats')
const amqp = require('amqplib')
const leaderElection = require('exp-leader-election')
const cnsl = require('consul')
const bluebird = require('bluebird')
const r = require('redis')

let consul = null

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

let redis = null

// The leadership status for this instance of the audit producer service
let IS_LEADER = false

// the amount of credits to top off all Nodes with daily
const creditTopoffAmount = 86400

// create a heartbeat for every 200ms
// 1 second heartbeats had a drift that caused occasional skipping of a whole second
// decreasing the interval of the heartbeat and checking current time resolves this
let heart = heartbeats.createHeart(200)

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// pull in variables defined in shared database models
let regNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let calBlockSequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock
let nodeAuditSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog
let Op = regNodeSequelize.Op

// Retrieve all registered Nodes with public_uris for auditing.
async function auditNodesAsync () {
  // get list of all Registered Nodes to audit
  let nodesReadyForAudit = []
  try {
    nodesReadyForAudit = await RegisteredNode.findAll({ attributes: ['tntAddr', 'publicUri', 'tntCredit'] })
    console.log(`${nodesReadyForAudit.length} public Nodes ready for audit were found`)
  } catch (error) {
    console.error(`Could not retrieve public Node list: ${error.message}`)
  }

  // iterate through each Registered Node, queue up an audit task for audit consumer
  for (let x = 0; x < nodesReadyForAudit.length; x++) {
    let auditTaskObj = {
      tntAddr: nodesReadyForAudit[x].tntAddr,
      publicUri: nodesReadyForAudit[x].publicUri,
      tntCredit: nodesReadyForAudit[x].tntCredit
    }
    try {
      await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_AUDIT_QUEUE, Buffer.from(JSON.stringify(auditTaskObj)), { persistent: true, type: 'audit' })
    } catch (error) {
      console.error(env.RMQ_WORK_OUT_AGG_QUEUE, 'publish message nacked')
    }
  }
  console.log(`Audit tasks queued for audit-consumer`)

  // wait 1 minute and then prune any old data from the table
  setTimeout(() => { pruneAuditDataAsync() }, 60000)
}

// Generate a new audit challenge for the Nodes. Audit challenges should be refreshed hourly.
// Audit challenges include a timestamp, minimum block height, maximum block height, and a nonce
async function generateAuditChallengeAsync () {
  try {
    let currentBlockHeight
    let topBlock = await CalendarBlock.findOne({ attributes: ['id'], order: [['id', 'DESC']] })
    if (topBlock) {
      currentBlockHeight = parseInt(topBlock.id, 10)
    } else {
      console.error('Cannot generate challenge, no genesis block found')
      return
    }
    // calculate min and max values with special exception for low block count
    let challengeTime = Date.now()
    let challengeMaxBlockHeight = currentBlockHeight > 2000 ? currentBlockHeight - 1000 : currentBlockHeight
    let randomNum = await rnd(10, 1000)
    let challengeMinBlockHeight = challengeMaxBlockHeight - randomNum
    if (challengeMinBlockHeight < 0) challengeMinBlockHeight = 0
    let challengeNonce = crypto.randomBytes(32).toString('hex')

    let challengeSolution = await calculateChallengeSolutionAsync(challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce)

    let auditChallenge = await cachedAuditChallenge.setNewAuditChallengeAsync(challengeTime, challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce, challengeSolution)

    console.log(`New challenge generated: ${auditChallenge}`)
  } catch (error) {
    console.error(`Could not generate audit challenge: ${error.message}`)
  }
}

async function calculateChallengeSolutionAsync (min, max, nonce) {
  let blocks = await CalendarBlock.findAll({ where: { id: { [Op.between]: [min, max] } }, order: [['id', 'ASC']] })

  if (blocks.length === 0) throw new Error('No blocks returned to create challenge tree')

  merkleTools.resetTree()

  // retrieve all block hashes from blocks array
  let leaves = blocks.map((block) => {
    let blockHashBuffer = Buffer.from(block.hash, 'hex')
    return blockHashBuffer
  })
  // add the nonce to the head of the leaves array
  leaves.unshift(Buffer.from(nonce, 'hex'))

  // Add every hash in leaves to new Merkle tree
  merkleTools.addLeaves(leaves)
  merkleTools.makeTree()

  // calculate the merkle root, the solution to the challenge
  let challengeSolution = merkleTools.getMerkleRoot().toString('hex')

  return challengeSolution
}

async function performCreditTopoffAsync (creditAmount) {
  try {
    await RegisteredNode.update({ tntCredit: creditAmount }, { where: { tntCredit: { [Op.lt]: creditAmount } } })
    console.log(`All Nodes topped off to ${creditAmount} credits`)
  } catch (error) {
    console.error(`Unable to perform credit topoff: ${error.message}`)
  }
}

async function pruneAuditDataAsync () {
  const cutoffTimestamp = Date.now() - 360 * 60 * 1000 // 6 hours ago
  const pruneBatchSize = 250

  // select all the audit_at values that are ready to be pruned
  let auditAtTimes = await NodeAuditLog.findAll({ where: { audit_at: { [Op.lte]: cutoffTimestamp } }, attributes: ['audit_at'], order: [['audit_at', 'ASC']] })
  // get the plain object results form the sequelize return value
  for (let x = 0; x < auditAtTimes.length; x++) {
    auditAtTimes[x] = auditAtTimes[x].get({ plain: true })
  }

  // split the entire set of audit log rows into batches
  // and determine the audit_at start and end ranges for the batches
  let pruneBatchTasks = []
  let pruneBatchesNeeded = Math.ceil(auditAtTimes.length / pruneBatchSize)

  for (let x = 0; x < pruneBatchesNeeded; x++) {
    let startBoundIndex = x * pruneBatchSize
    let endBoundIndex = startBoundIndex + pruneBatchSize - 1
    if (endBoundIndex >= auditAtTimes.length) endBoundIndex = auditAtTimes.length - 1

    let newRange = {
      startBound: auditAtTimes[startBoundIndex].audit_at,
      endBound: auditAtTimes[endBoundIndex].audit_at
    }
    pruneBatchTasks.push(newRange)
  }

  for (let x = 0; x < pruneBatchTasks.length; x++) {
    try {
      await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_AUDIT_QUEUE, Buffer.from(JSON.stringify(pruneBatchTasks[x])), { persistent: true, type: 'prune' })
      console.log(`Batch ${x + 1} of ${pruneBatchTasks.length} publish message acked`)
    } catch (error) {
      console.error(env.RMQ_WORK_OUT_AUDIT_QUEUE, 'publish message nacked')
    }
  }
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await regNodeSequelize.sync({ logging: false })
      await calBlockSequelize.sync({ logging: false })
      await nodeAuditSequelize.sync({ logging: false })
      await cachedAuditChallenge.getAuditChallengeSequelize().sync({ logging: false })
      console.log('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

/**
 * Opens a Redis connection
 *
 * @param {string} connectionString - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  redis = r.createClient(redisURI)
  redis.on('ready', () => {
    bluebird.promisifyAll(redis)
    cachedAuditChallenge.setRedis(redis)
    console.log('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    cachedAuditChallenge.setRedis(null)
    console.error('Cannot establish Redis connection. Attempting in 5 seconds...')
    await utils.sleep(5000)
    openRedisConnection(redisURI)
  })
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection string for the RabbitMQ instance, an AMQP URI
 */
async function openRMQConnectionAsync (connectionString) {
  let rmqConnected = false
  while (!rmqConnected) {
    try {
      // connect to rabbitmq server
      let conn = await amqp.connect(connectionString)
      // create communication channel
      let chan = await conn.createConfirmChannel()
      // the connection and channel have been established
      chan.assertQueue(env.RMQ_WORK_OUT_AUDIT_QUEUE, { durable: true })
      // set 'amqpChannel' so that publishers have access to the channel
      amqpChannel = chan
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        await utils.sleep(5000)
        await openRMQConnectionAsync(connectionString)
      })
      console.log('RabbitMQ connection established')
      rmqConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

async function performLeaderElection () {
  IS_LEADER = false
  let leaderElectionConfig = {
    key: env.AUDIT_PRODUCER_LEADER_KEY,
    consul: {
      host: env.CONSUL_HOST,
      port: env.CONSUL_PORT,
      ttl: 15,
      lockDelay: 1
    }
  }

  leaderElection(leaderElectionConfig)
    .on('gainedLeadership', function () {
      console.log('This service instance has been chosen to be leader')
      IS_LEADER = true
    })
    .on('error', function () {
      console.error('This lock session has been invalidated, new lock session will be created')
      IS_LEADER = false
    })
}

async function checkForGenesisBlockAsync () {
  let genesisBlock
  while (!genesisBlock) {
    try {
      genesisBlock = await CalendarBlock.findOne({ where: { id: 0 } })
      // if the genesis block does not exist, wait 5 seconds and try again
      if (!genesisBlock) await utils.sleep(5000)
    } catch (error) {
      console.error(`Unable to query calendar: ${error.message}`)
      process.exit(1)
    }
  }
  console.log(`Genesis block found, calendar confirmed to exist`)
}

function setGenerateNewChallengeInterval () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NEW_AUDIT_CHALLENGES_PER_HOUR
  let newChallengeMinutes = []
  let minuteOfHour = 0
  while (minuteOfHour < 60) {
    newChallengeMinutes.push(minuteOfHour)
    minuteOfHour += (60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (newChallengeMinutes.includes(currentMinute) && IS_LEADER) {
        try {
          await generateAuditChallengeAsync()
        } catch (error) {
          console.error('generateAuditChallengeAsync err: ', error.message)
        }
      }
    }
  })
}

function setPerformNodeAuditInterval () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NODE_AUDIT_ROUNDS_PER_HOUR
  let nodeAuditRoundsMinutes = []
  let minuteOfHour = 0
  // offset interval to spread the work around the clock a little bit,
  // to prevent everything from happening at the top of the hour
  let offset = Math.floor((60 / env.NODE_AUDIT_ROUNDS_PER_HOUR) / 2)
  while (minuteOfHour < 60) {
    let offsetMinutes = minuteOfHour + offset + ((minuteOfHour + offset) < 60 ? 0 : -60)
    nodeAuditRoundsMinutes.push(offsetMinutes)
    minuteOfHour += (60 / env.NODE_AUDIT_ROUNDS_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (nodeAuditRoundsMinutes.includes(currentMinute) && IS_LEADER) {
        try {
          await auditNodesAsync()
        } catch (error) {
          console.error('auditNodesAsync err: ', error.message)
        }
      }
    }
  })
}

function setPerformCreditTopoffInterval () {
  let currentDay = new Date().getUTCDate()

  heart.createEvent(5, async function (count, last) {
    let now = new Date()

    // if we are on a new day
    if (now.getUTCDate() !== currentDay) {
      currentDay = now.getUTCDate()
      await performCreditTopoffAsync(creditTopoffAmount)
    }
  })
}

async function startWatchesAndIntervalsAsync () {
  // attempt to generate a new audit challenge on startup
  if (IS_LEADER) {
    try {
      await generateAuditChallengeAsync()
    } catch (error) {
      console.error('generateAuditChallengeAsync err: ', error.message)
    }
  }

  setGenerateNewChallengeInterval()
  setPerformNodeAuditInterval()
  setPerformCreditTopoffInterval()
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init consul
    consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
    cachedAuditChallenge.setConsul(consul)
    console.log('Consul connection established')
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init consul and perform leader election
    performLeaderElection()
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // ensure at least 1 calendar block exist
    await checkForGenesisBlockAsync()
    // start main processing
    await startWatchesAndIntervalsAsync()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
