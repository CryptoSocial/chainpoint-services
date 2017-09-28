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
const auditChallenge = require('./lib/models/AuditChallenge.js')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const crypto = require('crypto')
const rnd = require('random-number-csprng')
const MerkleTools = require('merkle-tools')
const cnsl = require('consul')
const _ = require('lodash')
const heartbeats = require('heartbeats')
const amqp = require('amqplib')
const bluebird = require('bluebird')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// Time of the last performed round of auditing
// This value is updated from consul events as changes are detected
let auditLatest = null

// the fuzz factor for anchor interval meant to give each core instance a random chance of being first
const maxFuzzyMS = 1000

// the amount of credits to top off all Nodes with daily
const creditTopoffAmount = 86400

// create a heartbeat for every 200ms
// 1 second heartbeats had a drift that caused occasional skipping of a whole second
// decreasing the interval of the heartbeat and checking current time resolves this
let heart = heartbeats.createHeart(200)

let consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
bluebird.promisifyAll(consul.kv)
console.log('Consul connection established')

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// pull in variables defined in shared database models
let regNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let calBlockSequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock
let auditChallengeSequelize = auditChallenge.sequelize
let AuditChallenge = auditChallenge.AuditChallenge
let nodeAuditSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog

let challengeLockOpts = {
  key: env.CHALLENGE_LOCK_KEY,
  lockwaittime: '60s',
  lockwaittimeout: '60s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'challenge-lock',
    ttl: '30s'
  }
}

let challengeLock = consul.lock(_.merge({}, challengeLockOpts, { value: 'challenge' }))

let auditLockOpts = {
  key: env.AUDIT_LOCK_KEY,
  lockwaittime: '120s',
  lockwaittimeout: '120s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'audit-lock',
    ttl: '60s' // at 30s, the lock was deleting before large audit processes would complete
  }
}

let auditLock = consul.lock(_.merge({}, auditLockOpts, { value: 'audit' }))

function registerLockEvents (lock, lockName, acquireFunction) {
  lock.on('acquire', () => {
    console.log(`${lockName} acquired`)
    acquireFunction()
  })

  lock.on('error', (err) => {
    console.error(`${lockName} error - ${err}`)
  })

  lock.on('release', () => {
    console.log(`${lockName} release`)
  })
}

// LOCK HANDLERS : challenge
registerLockEvents(challengeLock, 'challengeLock', async () => {
  try {
    let newChallengeIntervalMinutes = 60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR
    // check if the last challenge is at least newChallengeIntervalMinutes - oneMinuteMS old
    // if not, return and release lock
    let mostRecentChallenge = await AuditChallenge.findOne({ order: [['time', 'DESC']] })
    if (mostRecentChallenge) {
      let oneMinuteMS = 60000
      let currentMS = Date.now()
      let ageMS = currentMS - mostRecentChallenge.time
      let lastChallengeTooRecent = (ageMS < (newChallengeIntervalMinutes * 60 * 1000 - oneMinuteMS))
      if (lastChallengeTooRecent) {
        let ageSec = Math.round(ageMS / 1000)
        console.log(`No work: ${newChallengeIntervalMinutes} minutes must elapse between each new audit challenge. The last one was generated ${ageSec} seconds ago.`)
        return
      }
    }
    await generateAuditChallengeAsync()
  } catch (error) {
    console.error(`Unable to generate audit challenge: ${error.message}`)
  } finally {
    // always release lock
    challengeLock.release()
  }
})

// LOCK HANDLERS : challenge
registerLockEvents(auditLock, 'auditLock', async () => {
  try {
    await auditNodesAsync()
  } catch (error) {
    console.error(`Unable to perform node audits: ${error.message}`)
  } finally {
    // always release lock
    auditLock.release()
  }
})

// Retrieve all registered Nodes with public_uris for auditing.
async function auditNodesAsync () {
  // only perform these steps if the lastest audit round was at least 10 minutes ago
  // to account for multiple Cores trying to process this interval at once
  let auditDate = Date.now()
  let maxPreviousAuditDate = auditDate - (10 * 60 * 1000)
  let readyForNextAuditRound = parseInt(auditLatest || 0) < maxPreviousAuditDate
  if (readyForNextAuditRound) {
    // update auditLatest
    try {
      await consul.kv.setAsync(env.LAST_AUDIT_KEY, auditDate.toString())
    } catch (error) {
      console.error(`Unable to update consul LAST_AUDIT_KEY: ${error.message}`)
      return
    }

    try {
      // prune any old data from the table before adding new entries
      await pruneAuditDataAsync()
    } catch (error) {
      console.error(`Unable to prune audit data: ${error.message}`)
    }

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
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_AUDIT_QUEUE, Buffer.from(JSON.stringify(auditTaskObj)), { persistent: true })
      } catch (error) {
        console.error(env.RMQ_WORK_OUT_AGG_QUEUE, 'publish message nacked')
      }
    }
    console.log(`Audit tasks queued for audit-consumer`)
  } else {
    console.log(`Audit tasks have already been queued for this audit interval`)
  }
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
      console.error('Cannot generate challenge, no genesis block found.')
      return
    }
    // calulcate min and max values with special exception for low block count
    let challengeTime = Date.now()
    let challengeMaxBlockHeight = currentBlockHeight > 2000 ? currentBlockHeight - 1000 : currentBlockHeight
    let randomNum = await rnd(10, 1000)
    let challengeMinBlockHeight = challengeMaxBlockHeight - randomNum
    if (challengeMinBlockHeight < 0) challengeMinBlockHeight = 0
    let challengeNonce = crypto.randomBytes(32).toString('hex')

    let challengeSolution = await calculateChallengeSolutionAsync(challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce)

    let newChallenge = await AuditChallenge.create({
      time: challengeTime,
      minBlock: challengeMinBlockHeight,
      maxBlock: challengeMaxBlockHeight,
      nonce: challengeNonce,
      solution: challengeSolution
    })
    let auditChallenge = `${newChallenge.time}:${newChallenge.minBlock}:${newChallenge.maxBlock}:${newChallenge.nonce}:${newChallenge.solution}`
    console.log(`New challenge generated: ${auditChallenge}`)
  } catch (error) {
    console.error((`Could not generate audit challenge: ${error.message}`))
  }
}

async function calculateChallengeSolutionAsync (min, max, nonce) {
  let blocks = await CalendarBlock.findAll({ where: { id: { $between: [min, max] } }, order: [['id', 'ASC']] })

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
    await RegisteredNode.update({ tntCredit: creditAmount }, { where: { tntCredit: { $lt: creditAmount } } })
    console.log(`All Nodes topped off to ${creditAmount} credits`)
  } catch (error) {
    console.error(`Unable to perform credit topoff: ${error.message}`)
  }
}

async function pruneAuditDataAsync () {
  let cutoffTimestamp = Date.now() - 360 * 60 * 1000 // 6 hours ago
  let resultCount = await NodeAuditLog.destroy({ where: { audit_at: { $lt: cutoffTimestamp } } })
  if (resultCount > 0) {
    console.log(`Pruned ${resultCount} records from the Audit log older than 6 hours`)
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
      await auditChallengeSequelize.sync({ logging: false })
      console.log('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      console.log(error.message)
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
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
  // offset interval to spread the work around the clock a little bit,
  // to prevent everuything from happening at the top of the hour
  let offset = Math.floor((60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR) / 2)
  while (minuteOfHour < 60) {
    let offsetMinutes = minuteOfHour + offset + ((minuteOfHour + offset) < 60 ? 0 : -60)
    newChallengeMinutes.push(offsetMinutes)
    minuteOfHour += (60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (newChallengeMinutes.includes(currentMinute)) {
        let randomFuzzyMS = await rnd(0, maxFuzzyMS)
        setTimeout(() => {
          try {
            challengeLock.acquire()
          } catch (error) {
            console.error('challengeLock.acquire(): caught err: ', error.message)
          }
        }, randomFuzzyMS)
      }
    }
  })
}

function setPerformNodeAuditInterval () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NODE_AUDIT_ROUNDS_PER_HOUR
  let nodeAuditRoundsMinutes = []
  let minuteOfHour = 0
  while (minuteOfHour < 60) {
    nodeAuditRoundsMinutes.push(minuteOfHour)
    minuteOfHour += (60 / env.NODE_AUDIT_ROUNDS_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (nodeAuditRoundsMinutes.includes(currentMinute)) {
        let randomFuzzyMS = await rnd(0, maxFuzzyMS)
        setTimeout(() => {
          try {
            auditLock.acquire()
          } catch (error) {
            console.error('auditLock.acquire(): caught err: ', error.message)
          }
        }, randomFuzzyMS)
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
  // Continuous watch on the consul key holding the NIST object.
  var lastAuditWatch = consul.watch({ method: consul.kv.get, options: { key: env.LAST_AUDIT_KEY } })

  // Store the updated nist object on change
  lastAuditWatch.on('change', async function (data, res) {
    // process only if a value has been returned and it is different than what is already stored
    if (data && data.Value && auditLatest !== data.Value) {
      auditLatest = data.Value
    }
  })

  lastAuditWatch.on('error', function (err) {
    console.error('lastAuditWatch error: ', err)
  })

  // attempt to generate a new audit chalenge on startup
  let randomFuzzyMS = await rnd(0, maxFuzzyMS)
  setTimeout(() => {
    try {
      challengeLock.acquire()
    } catch (error) {
      console.error('challengeLock.acquire(): caught err: ', error.message)
    }
  }, randomFuzzyMS)

  setGenerateNewChallengeInterval()
  setPerformNodeAuditInterval()
  setPerformCreditTopoffInterval()
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init DB
    await openStorageConnectionAsync()
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
