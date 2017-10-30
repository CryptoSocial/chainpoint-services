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
const env = require('./lib/parse-env.js')('cal')

const async = require('async')
const _ = require('lodash')
const MerkleTools = require('merkle-tools')
const amqp = require('amqplib')
const uuidv1 = require('uuid/v1')
const crypto = require('crypto')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const cnsl = require('consul')
const utils = require('./lib/utils.js')
const heartbeats = require('heartbeats')
const rand = require('random-number-csprng')
const rp = require('request-promise-native')

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

// Pass SIGNING_SECRET_KEY as Base64 encoded bytes
const signingSecretKeyBytes = nacl.util.decodeBase64(env.SIGNING_SECRET_KEY)
const signingKeypair = nacl.sign.keyPair.fromSecretKey(signingSecretKeyBytes)

const zeroStr = '0000000000000000000000000000000000000000000000000000000000000000'

// the fuzz factor for anchor interval meant to give each core instance a random chance of being first
const maxFuzzyMS = 1000

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// An array of all Merkle tree roots from aggregators needing
// to be processed. Will be filled as new roots arrive on the queue.
let AGGREGATION_ROOTS = []

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The latest NIST data
// This value is updated from consul events as changes are detected
let nistLatest = null

// An array of all Btc-Mon messages received and awaiting processing
let BTC_MON_MESSAGES = []

// Most recent Reward message received and awaiting processing
let rewardLatest = null

// The URI to use for requests to the eth-tnt-tx service
let ethTntTxUri = env.ETH_TNT_TX_CONNECT_URI

// create a heartbeat for every 200ms
// 1 second heartbeats had a drift that caused occasional skipping of a whole second
// decreasing the interval of the heartbeat and checking current time resolves this
let heart = heartbeats.createHeart(200)

// pull in variables defined in shared CalendarBlock module
let sequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock

let consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
console.log('Consul connection established')

// Calculate the hash of the signing public key bytes
// to allow lookup of which pubkey was used to sign
// a block. Handles different organizations signing blocks
// with different keys and key rotation by those orgs.
// When a Base64 pubKey is published publicly it should also
// be accompanied by this hash of its bytes to serve
// as a fingerprint.
let calcSigningPubKeyHashHex = (pubKey) => {
  return crypto.createHash('sha256').update(pubKey).digest('hex')
}
const signingPubKeyHashHex = calcSigningPubKeyHashHex(signingKeypair.publicKey)

// Calculate a deterministic block hash and return a Buffer hash value
let calcBlockHashHex = (block) => {
  let prefixString = `${block.id.toString()}:${block.time.toString()}:${block.version.toString()}:${block.stackId.toString()}:${block.type.toString()}:${block.dataId.toString()}`
  let prefixBuffer = Buffer.from(prefixString, 'utf8')
  let dataValBuffer = utils.isHex(block.dataVal) ? Buffer.from(block.dataVal, 'hex') : Buffer.from(block.dataVal, 'utf8')
  let prevHashBuffer = Buffer.from(block.prevHash, 'hex')

  return crypto.createHash('sha256').update(Buffer.concat([
    prefixBuffer,
    dataValBuffer,
    prevHashBuffer
  ])).digest('hex')
}

// Calculate a base64 encoded signature over the block hash
let calcBlockHashSigB64 = (blockHashHex) => {
  return nacl.util.encodeBase64(nacl.sign.detached(nacl.util.decodeUTF8(blockHashHex), signingKeypair.secretKey))
}

// The write function used by all block creation functions to write to calendar blockchain
let writeBlockAsync = async (height, type, dataId, dataVal, prevHash, friendlyName) => {
  let b = {}
  b.id = height
  b.time = Math.trunc(Date.now() / 1000)
  b.version = 1
  b.stackId = env.CHAINPOINT_CORE_BASE_URI
  b.type = type
  b.dataId = dataId
  b.dataVal = dataVal
  b.prevHash = prevHash

  let blockHashHex = calcBlockHashHex(b)
  b.hash = blockHashHex

  // pre-pend Base64 signature with truncated chars of SHA256 hash of the
  // pubkey bytes, joined with ':', to allow for lookup of signing pubkey.
  b.sig = [signingPubKeyHashHex.slice(0, 12), calcBlockHashSigB64(blockHashHex)].join(':')

  try {
    let block = await CalendarBlock.create(b)
    console.log(`${friendlyName} BLOCK: id: ${block.get({ plain: true }).id}`)
    return block.get({ plain: true })
  } catch (error) {
    throw new Error(`${friendlyName} BLOCK create error: ${error.message}: ${error.stack}`)
  }
}

let createGenesisBlockAsync = async () => {
  let writeResult = await writeBlockAsync(0, 'gen', '0', zeroStr, zeroStr, 'GENESIS')
  return writeResult
}

let createCalendarBlockAsync = async (root) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      return await writeBlockAsync(newId, 'cal', newId.toString(), root.toString(), prevBlock.hash, 'CAL')
    } else {
      throw new Error('no genesis block found')
    }
  } catch (error) {
    throw new Error(`Could not write calendar block: ${error.message}`)
  }
}

let createNistBlockAsync = async (nistDataObj) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      let dataId = nistDataObj.split(':')[0].toString() // the epoch timestamp for this NIST entry
      let dataVal = nistDataObj.split(':')[1].toString()  // the hex value for this NIST entry
      return await writeBlockAsync(newId, 'nist', dataId, dataVal, prevBlock.hash, 'NIST')
    } else {
      throw new Error('no genesis block found')
    }
  } catch (error) {
    throw new Error(`Could not write NIST block: ${error.message}`)
  }
}

let createBtcAnchorBlockAsync = async (root) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      console.log(newId, 'btc-a', '', root.toString(), prevBlock.hash, 'BTC-ANCHOR')
      return await writeBlockAsync(newId, 'btc-a', '', root.toString(), prevBlock.hash, 'BTC-ANCHOR')
    } else {
      throw new Error('no genesis block found')
    }
  } catch (error) {
    throw new Error(`Could not write btc anchor block: ${error.message}`)
  }
}

let createBtcConfirmBlockAsync = async (height, root) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      return await writeBlockAsync(newId, 'btc-c', height.toString(), root.toString(), prevBlock.hash, 'BTC-CONFIRM')
    } else {
      throw new Error('no genesis block found')
    }
  } catch (error) {
    throw new Error(`Could not write btc confirm block: ${error.message}`)
  }
}

let createRewardBlockAsync = async (dataId, dataVal) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      return await writeBlockAsync(newId, 'reward', dataId.toString(), dataVal.toString(), prevBlock.hash, 'REWARD')
    } else {
      throw new Error('no genesis block found')
    }
  } catch (error) {
    throw new Error(`Could not write reward block: ${error.message}`)
  }
}

/**
* Parses a message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
function processMessage (msg) {
  if (msg !== null) {
    // determine the source of the message and handle appropriately
    switch (msg.properties.type) {
      case 'aggregator':
        consumeAggRootMessage(msg)
        break
      case 'btctx':
        if (env.ANCHOR_BTC === 'enabled') {
          // Consumes a tx message from the btctx service
          consumeBtcTxMessageAsync(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] publish message acked : btc disabled', msg.btctx_id)
          amqpChannel.ack(msg)
        }
        break
      case 'btcmon':
        if (env.ANCHOR_BTC === 'enabled') {
          // Consumes a mon message from the btcmon service
          consumeBtcMonMessage(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[btcmon] publish message acked : btc disabled', msg.btctx_id)
          amqpChannel.ack(msg)
        }
        break
      case 'reward':
        consumeRewardMessage(msg)
        break
      default:
        // This is an unknown message type
        console.error('Unknown message type', msg.properties.type)
        // cannot handle unknown type messages, ack message and do nothing
        amqpChannel.ack(msg)
    }
  }
}

function consumeAggRootMessage (msg) {
  if (msg !== null) {
    let rootObj = JSON.parse(msg.content.toString())

    // add msg to the root object so that we can ack it during the persistCalendarTreeAsync process
    rootObj.msg = msg
    AGGREGATION_ROOTS.push(rootObj)
  }
}

async function consumeBtcTxMessageAsync (msg) {
  if (msg !== null) {
    let btcTxObj = JSON.parse(msg.content.toString())

    // add a small delay to prevent btc-mon from attempting to monitor a transaction
    // before the Bitcore API even acknowledges the existence of the transaction (404)
    await utils.sleep(30000)

    async.series([
      (callback) => {
        // queue up message containing updated proof state bound for proof state service
        let stateObj = {}
        stateObj.anchor_btc_agg_id = btcTxObj.anchor_btc_agg_id
        stateObj.btctx_id = btcTxObj.btctx_id
        let anchorBTCAggRoot = btcTxObj.anchor_btc_agg_root
        let btctxBody = btcTxObj.btctx_body
        let prefix = btctxBody.substr(0, btctxBody.indexOf(anchorBTCAggRoot))
        let suffix = btctxBody.substr(btctxBody.indexOf(anchorBTCAggRoot) + anchorBTCAggRoot.length)
        stateObj.btctx_state = {}
        stateObj.btctx_state.ops = [
          { l: prefix },
          { r: suffix },
          { op: 'sha-256-x2' }
        ]

        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btctx' },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              // console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message acked')
              return callback(null)
            }
          })
      },
      // inform btc-mon of new tx_id to watch, queue up message bound for btc mon
      (callback) => {
        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, Buffer.from(JSON.stringify({ tx_id: btcTxObj.btctx_id })), { persistent: true },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              // console.log(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message acked')
              return callback(null)
            }
          })
      }
    ], (err, results) => {
      if (err) {
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] consume message nacked', btcTxObj.btctx_id)
      } else {
        amqpChannel.ack(msg)
        console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] consume message acked', btcTxObj.btctx_id)
      }
    })
  }
}

function consumeBtcMonMessage (msg) {
  if (msg !== null) {
    BTC_MON_MESSAGES.push(msg)
    try {
      btcConfirmLock.acquire()
    } catch (error) {
      console.error('btcConfirmLock.acquire(): caught err: ', error.message)
    }
  }
}

function consumeRewardMessage (msg) {
  if (msg !== null) {
    rewardLatest = msg
    try {
      rewardLock.acquire()
    } catch (error) {
      console.error('rewardLock.acquire(): caught err : ', error.message)
    }
  }
}

/**
 * Converts proof path array output from the merkle-tools package
 * to a Chainpoint v3 ops array
 *
 * @param {proof object array} proof - The proof array generated by merkle-tools
 * @param {string} op - The hash type performed throughout merkle tree construction (sha-256, sha-512, sha-256-x2, etc.)
 * @returns {ops object array}
 */
function formatAsChainpointV3Ops (proof, op) {
  proof = proof.map((item) => {
    if (item.left) {
      return { l: item.left }
    } else {
      return { r: item.right }
    }
  })
  let ChainpointV3Ops = []
  for (let x = 0; x < proof.length; x++) {
    ChainpointV3Ops.push(proof[x])
    ChainpointV3Ops.push({ op: op })
  }
  return ChainpointV3Ops
}

// Take work off of the AGGREGATION_ROOTS array and build Merkle tree
let generateCalendarTree = () => {
  let rootsForTree = AGGREGATION_ROOTS.splice(0)

  let treeDataObj = null
  // create merkle tree only if there is at least one root to process
  if (rootsForTree.length > 0) {
    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // get root values from root objects
    let leaves = rootsForTree.map((rootObj) => {
      return rootObj.agg_root
    })

    // Add every root in rootsForTree to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // Collect and store the Merkle root and proofs in an object
    treeDataObj = {}
    treeDataObj.cal_root = merkleTools.getMerkleRoot()

    let treeSize = merkleTools.getLeafCount()
    let proofData = []
    for (let x = 0; x < treeSize; x++) {
      // push the agg_id and corresponding proof onto the array
      let proofDataItem = {}
      proofDataItem.agg_id = rootsForTree[x].agg_id
      proofDataItem.agg_msg = rootsForTree[x].msg
      let proof = merkleTools.getProof(x)
      proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
      proofData.push(proofDataItem)
    }
    treeDataObj.proofData = proofData
    console.log('rootsForTree length : %s', rootsForTree.length)
  }
  return treeDataObj
}

// Write tree to calendar block DB and also to proof state service via RMQ
let persistCalendarTreeAsync = async (treeDataObj) => {
  // get an array of messages to be acked or nacked in this process
  let messages = treeDataObj.proofData.map((proofDataItem) => {
    return proofDataItem.agg_msg
  })

  try {
    // Store Merkle root of calendar in DB and chain to previous calendar entries
    let block = await createCalendarBlockAsync(treeDataObj.cal_root.toString('hex'))

    // queue proof state messages for each aggregation root in the tree
    // for each aggregation root, queue up message containing
    // updated proof state bound for proof state service
    for (let x = 0; x < treeDataObj.proofData.length; x++) {
      let proofDataItem = treeDataObj.proofData[x]
      let stateObj = {}
      stateObj.agg_id = proofDataItem.agg_id
      stateObj.cal_id = block.id
      stateObj.cal_state = {}
      // add ops connecting agg_root to cal_root
      stateObj.cal_state.ops = proofDataItem.proof
      // add ops extending proof path beyond cal_root to calendar block's block_hash
      stateObj.cal_state.ops.push({ l: `${block.id}:${block.time}:${block.version}:${block.stackId}:${block.type}:${block.dataId}` })
      stateObj.cal_state.ops.push({ r: block.prevHash })
      stateObj.cal_state.ops.push({ op: 'sha-256' })

      // Build the anchors uris using the locations configured in CHAINPOINT_CORE_BASE_URI
      let BASE_URIS = [env.CHAINPOINT_CORE_BASE_URI]
      let uris = []
      for (let x = 0; x < BASE_URIS.length; x++) uris.push(`${BASE_URIS[x]}/calendar/${block.id}/hash`)
      stateObj.cal_state.anchor = {
        anchor_id: block.id,
        uris: uris
      }

      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'cal' })
        // New message has been published
        // console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[cal] publish message acked')
      } catch (error) {
        // An error as occurred publishing a message
        console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[cal] publish message nacked')
        throw new Error(`Unable to publish state message: ${error.message}`)
      }
    }

    _.forEach(messages, (message) => {
      if (message !== null) {
        // ack consumption of all original messages part of this aggregation event
        let rootObj = JSON.parse(message.content.toString())
        amqpChannel.ack(message)
        console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[aggregator] consume message acked', rootObj.agg_id)
      }
    })
  } catch (error) {
    _.forEach(messages, (message) => {
      // nack consumption of all original messages part of this aggregation event
      if (message !== null) {
        amqpChannel.nack(message)
        let rootObj = JSON.parse(message.content.toString())
        console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[aggregator] consume message nacked', rootObj.agg_id)
      }
    })
    throw new Error(error.message)
  }
}

// Aggregate all block hashes on chain since last BTC anchor block, add new
// BTC anchor block to calendar, add new proof state entries, anchor root
let aggregateAndAnchorBTCAsync = async (lastBtcAnchorBlockId) => {
  try {
    // Retrieve calendar blocks since last anchor block
    if (!lastBtcAnchorBlockId) lastBtcAnchorBlockId = -1
    let blocks = await CalendarBlock.findAll({ where: { id: { $gt: lastBtcAnchorBlockId } }, attributes: ['id', 'type', 'hash'], order: [['id', 'ASC']] })

    if (blocks.length === 0) throw new Error('No blocks returned to create btc anchor tree')

    // Build merkle tree with block hashes
    let leaves = blocks.map((blockObj) => {
      return blockObj.hash
    })

    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // Add every blockHash in blocks to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // get the total count of leaves in this aggregation
    let treeSize = merkleTools.getLeafCount()

    let treeData = {}
    treeData.anchor_btc_agg_id = uuidv1()
    treeData.anchor_btc_agg_root = merkleTools.getMerkleRoot().toString('hex')

    let proofData = []
    for (let x = 0; x < treeSize; x++) {
      // for calendar type blocks only, push the cal_id and corresponding proof onto the array
      if (blocks[x].type === 'cal') {
        let proofDataItem = {}
        proofDataItem.cal_id = blocks[x].id
        let proof = merkleTools.getProof(x)
        proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
        proofData.push(proofDataItem)
      }
    }
    treeData.proofData = proofData

    console.log('blocks length : %s', blocks.length)

    // if the amqp channel is null (closed), processing should not continue, defer to next interval
    if (amqpChannel === null) return

    // Create new btc anchor block with resulting tree root
    await createBtcAnchorBlockAsync(treeData.anchor_btc_agg_root)

    // For each calendar record block in the tree, add proof state
    // item containing proof ops from block_hash to anchor_btc_agg_root
    async.series([
      (seriesCallback) => {
        // for each calendar block hash, queue up message containing updated
        // proof state bound for proof state service
        async.each(treeData.proofData, (proofDataItem, eachCallback) => {
          let stateObj = {}
          stateObj.cal_id = proofDataItem.cal_id
          stateObj.anchor_btc_agg_id = treeData.anchor_btc_agg_id
          stateObj.anchor_btc_agg_state = {}
          stateObj.anchor_btc_agg_state.ops = proofDataItem.proof

          amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'anchor_btc_agg' },
            (err, ok) => {
              if (err !== null) {
                // An error as occurred publishing a message
                console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[anchor_btc_agg] publish message nacked')
                return eachCallback(err)
              } else {
                // New message has been published
                // console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[anchor_btc_agg] publish message acked')
                return eachCallback(null)
              }
            })
        }, (err) => {
          if (err) {
            console.error('Anchor aggregation had errors')
            return seriesCallback(err)
          } else {
            console.log('Anchor aggregation complete')
            return seriesCallback(null)
          }
        })
      },
      (seriesCallback) => {
        // Create anchor_btc_agg message data object for anchoring service(s)
        let anchorData = {
          anchor_btc_agg_id: treeData.anchor_btc_agg_id,
          anchor_btc_agg_root: treeData.anchor_btc_agg_root
        }

        // Send anchorData to the btc tx service for anchoring
        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, Buffer.from(JSON.stringify(anchorData)), { persistent: true },
          (err, ok) => {
            if (err !== null) {
              console.error(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message nacked')
              return seriesCallback(err)
            } else {
              // console.log(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message acked')
              return seriesCallback(null)
            }
          })
      }
    ], (err) => {
      if (err) throw new Error(err)
      console.log('aggregateAndAnchorBTCAsync process complete.')
    })
  } catch (error) {
    throw new Error(`aggregateAndAnchorBTCAsync error: ${error.message}`)
  }
}

// Each of these locks must be defined up front since event handlers
// need to be registered for each. They are all effectively locking the same
// resource since they share the same CALENDAR_LOCK_KEY. The value is
// purely informational and allows you to see which entity is currently
// holding a lock in the Consul admin web app.
//
// See also : https://github.com/hashicorp/consul/blob/master/api/lock.go#L21
//
var lockOpts = {
  key: env.CALENDAR_LOCK_KEY,
  lockwaittime: '60s',
  lockwaittimeout: '60s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'calendar-blockchain-lock',
    ttl: '30s'
  }
}

let genesisLock = consul.lock(_.merge({}, lockOpts, { value: 'genesis' }))
let calendarLock = consul.lock(_.merge({}, lockOpts, { value: 'calendar' }))
let nistLock = consul.lock(_.merge({}, lockOpts, { value: 'nist' }))
let btcAnchorLock = consul.lock(_.merge({}, lockOpts, { value: 'btc-anchor' }))
let btcConfirmLock = consul.lock(_.merge({}, lockOpts, { value: 'btc-confirm' }))
let rewardLock = consul.lock(_.merge({}, lockOpts, { value: 'reward' }))

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

// LOCK HANDLERS : genesis
registerLockEvents(genesisLock, 'genesisLock', async () => {
  try {
    // The value of the lock determines what function it triggers
    // Is a genesis block needed? If not release lock and move on.
    let blockCount
    try {
      blockCount = await CalendarBlock.count()
    } catch (error) {
      throw new Error(`Unable to count calendar blocks: ${error.message}`)
    }
    if (blockCount === 0) {
      try {
        await createGenesisBlockAsync()
      } catch (error) {
        throw new Error(`Unable to create genesis block: ${error.message}`)
      }
    } else {
      console.log(`No genesis block needed: ${blockCount} block(s) found`)
    }
  } catch (error) {
    console.error(error.message)
  } finally {
    // always release lock
    try {
      genesisLock.release()
    } catch (error) {
      console.error(`genesisLock.release(): caught err: ${error.message}`)
    }
  }
})

// LOCK HANDLERS : calendar
registerLockEvents(calendarLock, 'calendarLock', async () => {
  try {
    let treeDataObj = generateCalendarTree()
    // if there is some data to process, continue and persist
    if (treeDataObj) {
      await persistCalendarTreeAsync(treeDataObj)
    } else {
      // there is nothing to process in this calendar interval, write nothing, release lock
      console.log('no hashes for this calendar interval')
    }
  } catch (error) {
    console.error(`Unable to create calendar block: ${error.message}`)
  } finally {
    // always release lock
    try {
      calendarLock.release()
    } catch (error) {
      console.error(`calendarLock.release(): caught err: ${error.message}`)
    }
  }
})

// LOCK HANDLERS : nist
registerLockEvents(nistLock, 'nistLock', async () => {
  try {
    let nistBlockIntervalMinutes = 60 / env.NIST_BLOCKS_PER_HOUR
    let lastNistBlock
    try {
      lastNistBlock = await CalendarBlock.findOne({ where: { type: 'nist' }, attributes: ['time', 'stackId'], order: [['id', 'DESC']] })
    } catch (error) {
      throw new Error(`Unable to retrieve most recent nist block: ${error.message}`)
    }
    if (lastNistBlock) {
      // checks if the last NIST block is at least nistBlockIntervalMinutes - oneMinuteMS old
      // Only if so, we write a new anchor and do the work of that function. Otherwise immediate release lock.
      let oneMinuteMS = 60000
      let lastNistBlockMS = lastNistBlock.time * 1000
      let currentMS = Date.now()
      let ageMS = currentMS - lastNistBlockMS
      let lastNISTTooRecent = (ageMS < (nistBlockIntervalMinutes * 60 * 1000 - oneMinuteMS))
      if (lastNISTTooRecent) {
        let ageSec = Math.round(ageMS / 1000)
        console.log(`No work: ${nistBlockIntervalMinutes} minutes must elapse between each new nist block. The last one was generated ${ageSec} seconds ago by Core ${lastNistBlock.stackId}.`)
        return
      }
    }
    await createNistBlockAsync(nistLatest)
  } catch (error) {
    console.error(`Unable to create NIST block: ${error.message}`)
  } finally {
    // always release lock
    try {
      nistLock.release()
    } catch (error) {
      console.error(`nistLock.release(): caught err: ${error.message}`)
    }
  }
})

// LOCK HANDLERS : btc-anchor
registerLockEvents(btcAnchorLock, 'btcAnchorLock', async () => {
  try {
    let btcAnchorIntervalMinutes = 60 / env.ANCHOR_BTC_PER_HOUR
    let lastBtcAnchorBlock
    try {
      lastBtcAnchorBlock = await CalendarBlock.findOne({ where: { type: 'btc-a', stackId: env.CHAINPOINT_CORE_BASE_URI }, attributes: ['id', 'hash', 'time', 'stackId'], order: [['id', 'DESC']] })
    } catch (error) {
      throw new Error(`Unable to retrieve most recent btc anchor block: ${error.message}`)
    }

    if (lastBtcAnchorBlock) {
      // checks if the last btc anchor block is at least btcAnchorIntervalMinutes - oneMinuteMS old
      // Only if so, we write a new anchor and do the work of that function. Otherwise immediate release lock.
      let oneMinuteMS = 60000
      let lastBtcAnchorMS = lastBtcAnchorBlock.time * 1000
      let currentMS = Date.now()
      let ageMS = currentMS - lastBtcAnchorMS
      let lastAnchorTooRecent = (ageMS < (btcAnchorIntervalMinutes * 60 * 1000 - oneMinuteMS))
      if (lastAnchorTooRecent) {
        let ageSec = Math.round(ageMS / 1000)
        console.log(`No work: ${btcAnchorIntervalMinutes} minutes must elapse between each new btc-a block. The last one was generated ${ageSec} seconds ago by Core ${lastBtcAnchorBlock.stackId}.`)
        return
      }
    }
    try {
      let lastBtcAnchorBlockId = lastBtcAnchorBlock ? parseInt(lastBtcAnchorBlock.id, 10) : null
      await aggregateAndAnchorBTCAsync(lastBtcAnchorBlockId)
    } catch (error) {
      throw new Error(`Unable to aggregate and create btc anchor block: ${error.message}`)
    }
  } catch (error) {
    console.error(error.message)
  } finally {
    // always release lock
    try {
      btcAnchorLock.release()
    } catch (error) {
      console.error(`btcAnchorLock.release(): caught err: ${error.message}`)
    }
  }
})

// LOCK HANDLERS : btc-confirm
registerLockEvents(btcConfirmLock, 'btcConfirmLock', async () => {
  try {
    let monMessagesToProcess = BTC_MON_MESSAGES.splice(0)
    // if there are no messages left to process, release lock and return
    if (monMessagesToProcess.length === 0) return

    for (let x = 0; x < monMessagesToProcess.length; x++) {
      let msg = monMessagesToProcess[x]

      let btcMonObj = JSON.parse(msg.content.toString())
      let btctxId = btcMonObj.btctx_id
      let btcheadHeight = btcMonObj.btchead_height
      let btcheadRoot = btcMonObj.btchead_root
      let proofPath = btcMonObj.path

      // Store Merkle root of BTC block in chain
      let block
      try {
        block = await createBtcConfirmBlockAsync(btcheadHeight, btcheadRoot)
      } catch (error) {
        throw new Error(`Unable to create btc confirm block: ${error.message}`)
      }

      // queue up message containing updated proof state bound for proof state service
      let stateObj = {}
      stateObj.btctx_id = btctxId
      stateObj.btchead_height = btcheadHeight
      stateObj.btchead_state = {}
      stateObj.btchead_state.ops = formatAsChainpointV3Ops(proofPath, 'sha-256-x2')

      // Build the anchors uris using the locations configured in CHAINPOINT_CORE_BASE_URI
      let BASE_URIS = [env.CHAINPOINT_CORE_BASE_URI]
      let uris = []
      for (let x = 0; x < BASE_URIS.length; x++) uris.push(`${BASE_URIS[x]}/calendar/${block.id}/data`)
      stateObj.btchead_state.anchor = {
        anchor_id: btcheadHeight.toString(),
        uris: uris
      }

      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btcmon' })
        // New message has been published
        // console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[btcmon] publish message acked')
      } catch (error) {
        // An error as occurred publishing a message
        console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[btcmon] publish message nacked')
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[btcmon] consume message nacked', stateObj.btctx_id)
        throw new Error(`Unable to publish state message: ${error.message}`)
      }

      // ack consumption of all original hash messages part of this aggregation event
      amqpChannel.ack(msg)
      console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[btcmon] consume message acked', stateObj.btctx_id)
    }
  } catch (error) {
    console.error(error.message)
  } finally {
    // always release lock
    try {
      btcConfirmLock.release()
    } catch (error) {
      console.error(`btcConfirmLock.release(): caught err: ${error.message}`)
    }
  }
})

// LOCK HANDLERS : reward
registerLockEvents(rewardLock, 'rewardLock', async () => {
  let msg = rewardLatest
  let rewardMsgObj = JSON.parse(msg.content.toString())

  try {
    // transfer TNT according to random reward message selection
    let nodeRewardTxId = ''
    let coreRewardTxId = ''
    let nodeRewardETHAddr = rewardMsgObj.node.address
    let nodeTNTGrainsRewardShare = rewardMsgObj.node.amount
    let coreRewardEthAddr = rewardMsgObj.core ? rewardMsgObj.core.address : null
    let coreTNTGrainsRewardShare = rewardMsgObj.core ? rewardMsgObj.core.amount : 0

    // reward TNT to ETH address for selected qualifying Node according to random reward message selection
    let postObject = {
      to_addr: nodeRewardETHAddr,
      value: nodeTNTGrainsRewardShare
    }

    let options = {
      headers: [
        {
          name: 'Content-Type',
          value: 'application/json'
        }
      ],
      method: 'POST',
      uri: `${ethTntTxUri}/transfer`,
      body: postObject,
      json: true,
      gzip: true,
      resolveWithFullResponse: true
    }

    try {
      let rewardResponse = await rp(options)
      nodeRewardTxId = rewardResponse.body.trx_id
      console.log(`${nodeTNTGrainsRewardShare} grains (${nodeTNTGrainsRewardShare / 10 ** 8} TNT) transferred to Node using ETH address ${nodeRewardETHAddr} in transaction ${nodeRewardTxId}`)
    } catch (error) {
      console.error(`${nodeTNTGrainsRewardShare} grains (${nodeTNTGrainsRewardShare / 10 ** 8} TNT) failed to be transferred to Node using ETH address ${nodeRewardETHAddr}: ${error.message}`)
    }

    // reward TNT to Core operator according to random reward message selection (if applicable)
    if (coreTNTGrainsRewardShare > 0) {
      let postObject = {
        to_addr: coreRewardEthAddr,
        value: coreTNTGrainsRewardShare
      }

      let options = {
        headers: [
          {
            name: 'Content-Type',
            value: 'application/json'
          }
        ],
        method: 'POST',
        uri: `${ethTntTxUri}/transfer`,
        body: postObject,
        json: true,
        gzip: true,
        resolveWithFullResponse: true
      }

      try {
        let rewardResponse = await rp(options)
        coreRewardTxId = rewardResponse.body.trx_id
        console.log(`${coreTNTGrainsRewardShare} grains (${coreTNTGrainsRewardShare / 10 ** 8} TNT) transferred to Core using ETH address ${coreRewardEthAddr} in transaction ${coreRewardTxId}`)
      } catch (error) {
        console.error(`${coreTNTGrainsRewardShare} grains (${coreTNTGrainsRewardShare / 10 ** 8} TNT) failed to be transferred to Core using ETH address ${coreRewardEthAddr}: ${error.message}`)
      }
    }

    // construct the reward block data
    let dataId = nodeRewardTxId
    let dataVal = [rewardMsgObj.node.address, rewardMsgObj.node.amount].join(':')
    if (rewardMsgObj.core) {
      dataId = [dataId, coreRewardTxId].join(':')
      dataVal = [dataVal, rewardMsgObj.core.address, rewardMsgObj.core.amount].join(':')
    }

    try {
      await createRewardBlockAsync(dataId, dataVal)
      // ack consumption of all original hash messages part of this aggregation event
      amqpChannel.ack(msg)
      console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[reward] consume message acked', rewardMsgObj.node.address)
    } catch (error) {
      // ack consumption of all original message
      // this message must be acked to avoid reward distribution to node from occuring again
      amqpChannel.ack(msg)
      console.error(env.RMQ_WORK_IN_CAL_QUEUE, `[reward] consume message acked with error: ${error.message} ${rewardMsgObj.node.address}`)
      throw new Error(`Unable to create reward block: ${error.message}`)
    }
  } catch (error) {
    console.error(error.message)
  } finally {
    // always release lock
    try {
      rewardLock.release()
    } catch (error) {
      console.error(`rewardLock.release(): caught err: ${error.message}`)
    }
  }
})

// Set the BTC anchor interval
let setBtcInterval = () => {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on ANCHOR_BTC_PER_HOUR
  let btcAnchorMinutes = []
  let minuteOfHour = 0
  while (minuteOfHour < 60) {
    btcAnchorMinutes.push(minuteOfHour)
    minuteOfHour += (60 / env.ANCHOR_BTC_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (btcAnchorMinutes.includes(currentMinute)) {
        // if the amqp channel is null (closed), processing should not continue, defer to next interval
        if (amqpChannel === null) return
        let randomFuzzyMS = await rand(0, maxFuzzyMS)
        setTimeout(() => {
          try {
            btcAnchorLock.acquire()
          } catch (error) {
            console.error('btcAnchorLock.acquire(): caught err: ', error.message)
          }
        }, randomFuzzyMS)
      }
    }
  })
}

// Set the NIST block interval
let setNISTBlockInterval = () => {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NIST_BLOCKS_PER_HOUR
  let nistBlockMinutes = []
  let minuteOfHour = 0
  // offset interval to minimize occurances of nist block at the same time as other blocks
  let offset = Math.floor((60 / env.NIST_BLOCKS_PER_HOUR) / 2)
  while (minuteOfHour < 60) {
    let offsetMinutes = minuteOfHour + offset + ((minuteOfHour + offset) < 60 ? 0 : -60)
    nistBlockMinutes.push(offsetMinutes)
    minuteOfHour += (60 / env.NIST_BLOCKS_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (nistBlockMinutes.includes(currentMinute)) {
        // if the nistLatest is null, processing should not continue, defer to next interval
        if (nistLatest === null) return
        let randomFuzzyMS = await rand(0, maxFuzzyMS)
        setTimeout(() => {
          try {
            nistLock.acquire()
          } catch (error) {
            console.error('nistLock.acquire(): caught err: ', error.message)
          }
        }, randomFuzzyMS)
      }
    }
  })
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await sequelize.sync({ logging: false })
      console.log('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
  // trigger creation of the genesis block
  genesisLock.acquire()
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
      chan.assertQueue(env.RMQ_WORK_IN_CAL_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_STATE_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_CAL)
      // set 'amqpChannel' so that publishers have access to the channel
      amqpChannel = chan
      chan.consume(env.RMQ_WORK_IN_CAL_QUEUE, (msg) => {
        processMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        // un-acked messaged will be requeued, so clear all work in progress
        AGGREGATION_ROOTS = []
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

// This initalizes all the consul watches and JS intervals that fire all calendar events
function startWatchesAndIntervals () {
  console.log('starting watches and intervals')

  // Continuous watch on the consul key holding the NIST object.
  var nistWatch = consul.watch({ method: consul.kv.get, options: { key: env.NIST_KEY } })

  // Store the updated nist object on change
  nistWatch.on('change', async function (data, res) {
    // process only if a value has been returned and it is different than what is already stored
    if (data && data.Value && nistLatest !== data.Value) {
      nistLatest = data.Value
    }
  })

  nistWatch.on('error', function (err) {
    console.error('nistWatch error: ', err)
  })

  // PERIODIC TIMERS

  // Init heartbeat process for NIST blocks
  setNISTBlockInterval()

  // Write a new calendar block
  setInterval(() => {
    try {
      // if the amqp channel is null (closed), processing should not continue, defer to next interval
      if (amqpChannel === null) return
      if (AGGREGATION_ROOTS.length > 0) { // there will be data to process, acquire lock and continue
        calendarLock.acquire()
      }
    } catch (error) {
      console.error('calendarLock.acquire(): caught err: ', error.message)
    }
  }, env.CALENDAR_INTERVAL_MS)

  // Add all block hashes back to the previous BTC anchor to a Merkle tree and send to BTC TX
  if (env.ANCHOR_BTC === 'enabled') { // Do this only if BTC anchoring is enabled
    setBtcInterval()
    console.log('BTC anchoring enabled')
  } else {
    console.log('BTC anchoring disabled')
  }
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init DB
    await openStorageConnectionAsync()
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // Init intervals and watches
    startWatchesAndIntervals()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
