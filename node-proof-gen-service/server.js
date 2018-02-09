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
const env = require('./lib/parse-env.js')('gen')

const amqp = require('amqplib')
const chainpointProofSchema = require('chainpoint-proof-json-schema')
const uuidTime = require('uuid-time')
const chpBinary = require('chainpoint-binary')
const utils = require('./lib/utils.js')
const bluebird = require('bluebird')

const storageClient = require('./lib/models/ProofStateModels.js')

const r = require('redis')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

function addChainpointHeader (proof, hash, hashId) {
  proof['@context'] = 'https://w3id.org/chainpoint/v3'
  proof.type = 'Chainpoint'
  proof.hash = hash

  // the following two values are added as placeholders
  // the spec does not allow for missing or empty values here
  // these values will be replaced with proper ones by the Node instance
  proof.hash_id_node = hashId
  proof.hash_submitted_node_at = utils.formatDateISO8601NoMs(new Date(parseInt(uuidTime.v1(hashId))))

  proof.hash_id_core = hashId
  proof.hash_submitted_core_at = proof.hash_submitted_node_at
  return proof
}

function addCalendarBranch (proof, aggState, calState) {
  let calendarBranch = {}
  calendarBranch.label = 'cal_anchor_branch'
  calendarBranch.ops = aggState.ops.concat(calState.ops)

  let calendarAnchor = {}
  calendarAnchor.type = 'cal'
  calendarAnchor.anchor_id = calState.anchor.anchor_id
  calendarAnchor.uris = calState.anchor.uris

  calendarBranch.ops.push({ anchors: [calendarAnchor] })

  proof.branches = [calendarBranch]
  return proof
}

function addBtcBranch (proof, anchorBTCAggState, btcTxState, btcHeadState) {
  let btcBranch = {}
  btcBranch.label = 'btc_anchor_branch'
  btcBranch.ops = anchorBTCAggState.ops.concat(btcTxState.ops, btcHeadState.ops)

  let btcAnchor = {}
  btcAnchor.type = 'btc'
  btcAnchor.anchor_id = btcHeadState.anchor.anchor_id
  btcAnchor.uris = btcHeadState.anchor.uris

  btcBranch.ops.push({ anchors: [btcAnchor] })

  proof.branches[0].branches = [btcBranch]
  return proof
}

/**
* Retrieves all proof state data for a given hash and initiates proof generation
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function consumeProofReadyMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())

  switch (messageObj.type) {
    case 'cal':
      try {
        let aggStateRow = await storageClient.getAggStateObjectByHashIdAsync(messageObj.hash_id)
        if (!aggStateRow) throw new Error(new Date().toISOString() + ' no matching agg_state data found')
        let calStateRow = await storageClient.getCalStateObjectByAggIdAsync(aggStateRow.agg_id)
        if (!calStateRow) throw new Error(new Date().toISOString() + ' no matching cal_state data found')

        let proof = {}
        proof = addChainpointHeader(proof, aggStateRow.hash, aggStateRow.hash_id)
        proof = addCalendarBranch(proof, JSON.parse(aggStateRow.agg_state), JSON.parse(calStateRow.cal_state))

        // ensure the proof is valid according to the defined Chainpoint v3 JSON schema
        let isValidSchema = chainpointProofSchema.validate(proof).valid
        if (!isValidSchema) {
          // This schema is not valid, ack the message but log an error and end processing
          // We are not nacking here because the poorly formatted proof would just be
          // re-qeueud and re-processed on and on forever
          amqpChannel.ack(msg)
          console.error(env.RMQ_WORK_IN_GEN_QUEUE, 'consume message acked, but with invalid JSON schema error')
          return
        }

        // store in redis
        await storeProofAsync(proof)

        // logs the calendar proof event
        await storageClient.logCalendarEventForHashIdAsync(aggStateRow.hash_id)
        // Proof ready message has been consumed, ack consumption of original message
        amqpChannel.ack(msg)
        console.log(msg.fields.routingKey, '[' + msg.properties.type + '] consume message acked')
      } catch (error) {
        console.error(`Unable to process proof ready message: ${error.message}`)
        // An error as occurred consuming a message, nack consumption of original message
        amqpChannel.nack(msg)
        console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
      }
      break
    case 'btc':
      try {
        // get the agg_state object for the hash_id
        let aggStateRow = await storageClient.getAggStateObjectByHashIdAsync(messageObj.hash_id)
        if (!aggStateRow) throw new Error(new Date().toISOString() + ' no matching agg_state data found')
        // get the cal_state object for the agg_id
        let calStateRow = await storageClient.getCalStateObjectByAggIdAsync(aggStateRow.agg_id)
        if (!calStateRow) throw new Error(new Date().toISOString() + ' no matching cal_state data found')
        // get the anchorBTCAgg_state object for the cal_id
        let anchorBTCAggStateRow = await storageClient.getAnchorBTCAggStateObjectByCalIdAsync(calStateRow.cal_id)
        if (!anchorBTCAggStateRow) throw new Error(new Date().toISOString() + ' no matching anchor_btc_agg_state data found')
        // get the btctx_state object for the anchor_btc_agg_id
        let btcTxStateRow = await storageClient.getBTCTxStateObjectByAnchorBTCAggIdAsync(anchorBTCAggStateRow.anchor_btc_agg_id)
        if (!btcTxStateRow) throw new Error(new Date().toISOString() + ' no matching btctx_state data found')
        // get the btcthead_state object for the btctx_id
        let btcHeadStateRow = await storageClient.getBTCHeadStateObjectByBTCTxIdAsync(btcTxStateRow.btctx_id)
        if (!btcHeadStateRow) throw new Error(new Date().toISOString() + ' no matching btchead_state data found')

        let proof = {}
        proof = addChainpointHeader(proof, aggStateRow.hash, aggStateRow.hash_id)
        proof = addCalendarBranch(proof, JSON.parse(aggStateRow.agg_state), JSON.parse(calStateRow.cal_state))
        proof = addBtcBranch(proof, JSON.parse(anchorBTCAggStateRow.anchor_btc_agg_state), JSON.parse(btcTxStateRow.btctx_state), JSON.parse(btcHeadStateRow.btchead_state))

        // ensure the proof is valid according to the defined Chainpoint v3 JSON schema
        let isValidSchema = chainpointProofSchema.validate(proof).valid
        if (!isValidSchema) {
          // This schema is not valid, ack the message but log an error and end processing
          // We are not nacking here because the poorly formatted proof would just be
          // re-qeueud and re-processed on and on forever
          amqpChannel.ack(msg)
          console.error(env.RMQ_WORK_IN_GEN_QUEUE, 'consume message acked, but with invalid JSON schema error')
          return
        }

        // store in redis
        await storeProofAsync(proof)

        // logs the btc proof event
        await storageClient.logBtcEventForHashIdAsync(aggStateRow.hash_id)
        // Proof ready message has been consumed, ack consumption of original message
        amqpChannel.ack(msg)
        console.log(msg.fields.routingKey, '[' + msg.properties.type + '] consume message acked')
      } catch (error) {
        console.error(`Unable to process proof ready message: ${error.message}`)
        // An error as occurred consuming a message, nack consumption of original message
        amqpChannel.nack(msg)
        console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
      }
      break
    case 'eth':
      console.log('building eth proof')
      amqpChannel.ack(msg)
      break
    default:
      // This is an unknown proof ready type
      console.error('Unknown proof ready type', messageObj.type)
      // cannot handle unknown type messages, ack message and do nothing
      amqpChannel.ack(msg)
  }
}

async function storeProofAsync (proof) {
  // compress proof to binary format Base64
  let proofBase64 = chpBinary.objectToBase64Sync(proof)
  // save proof to redis
  await redis.setAsync(proof.hash_id_core, proofBase64, 'EX', env.PROOF_EXPIRE_MINUTES * 60)
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
    console.log('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
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
      chan.assertQueue(env.RMQ_WORK_IN_GEN_QUEUE, { durable: true })
      chan.assertExchange(env.RMQ_OUTGOING_EXCHANGE, 'headers', { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_GEN)
      amqpChannel = chan
      // Continuously load the HASHES from RMQ with hash objects to process
      chan.consume(env.RMQ_WORK_IN_GEN_QUEUE, (msg) => {
        consumeProofReadyMessageAsync(msg)
      })
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

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await storageClient.openConnectionAsync()
      console.log('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init Postgres
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
