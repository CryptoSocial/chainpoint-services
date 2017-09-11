/* Copyright 2017 Tierion
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*     http://www.apache.org/licenses/LICENSE-2.0
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

// load all environment variables into env object
const env = require('./lib/parse-env.js')('eth-tnt-listener')

const ethTokenTxLog = require('./lib/models/EthTokenTrxLog.js')
const registeredNode = require('./lib/models/RegisteredNode.js')
const utils = require('./lib/utils.js')
const loadProvider = require('./lib/eth-tnt/providerLoader.js')
const loadToken = require('./lib/eth-tnt/tokenLoader.js')
const TokenOps = require('./lib/eth-tnt/tokenOps.js')
const BigNumber = require('bignumber.js')

// pull in variables defined in shared EthTokenTrxLog module
let ethTokenTxSequelize = ethTokenTxLog.sequelize
let EthTokenTxLog = ethTokenTxLog.EthTokenLog
let registeredNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode

// The provider, token contract, and create the TokenOps class
let web3Provider = null
let tokenContract = null
let ops = null

let lastEventInfo = null

/**
 * Get the last incoming transfer of TNT tokens we have seen and return block number and trx index
 */
async function getLastKnownEventInfoAsync () {
  let addresses = env.ETH_TNT_LISTEN_ADDRS.split(',')

  // Get the latest incoming transfer from the DB
  let lastTransfer = await EthTokenTxLog.findOne({
    where: { toAddress: { $in: addresses } },
    order: [['created_at', 'DESC']]
  })

  // Check to make sure one was found or we are in developement mode
  if (!lastTransfer || env.NODE_ENV === 'development') {
    // Not found, so set to 0s
    return {
      blockNumber: 0,
      transactionIndex: 0
    }
  }

  // Return the valid info
  return {
    blockNumber: lastTransfer.blockNumber,
    transactionIndex: lastTransfer.transactionIndex
  }
}

async function processNewTxAsync (params) {
  // Log out the transaction
  let tntGrainsAmount = params.args.value
  let tntAmount = new BigNumber(tntGrainsAmount).dividedBy(10 ** 8).toNumber()

  let tx = {
    txId: params.transactionHash,
    transactionIndex: params.transactionIndex,
    blockNumber: params.blockNumber,
    fromAddress: params.args.from,
    toAddress: params.args.to,
    amount: params.args.value
  }

  try {
    // Log the Ethereum token transfer event
    await EthTokenTxLog.create(tx)
    console.log(`${tntGrainsAmount} grains (${tntAmount} TNT) transferred from ${params.args.from} to ${params.args.to} on block ${params.blockNumber}`)
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      // this transaction has already been processed by another Core instance
      console.log(`Transaction ${tx.txId} has already been logged by another Core instance`)
      return
    }
    console.error(`Unable to add eth transaction to log: ${error.message}`)
    return
  }

  let nodeToCredit
  try {
    // Find the node that sent in the balance
    nodeToCredit = await RegisteredNode.findOne({ where: { tntAddr: tx.fromAddress } })
    if (!nodeToCredit) {
      // TODO - Store unkowns for later processing if node registers after sending in for some reason
      // NOTE - If a node sends in TNT before it registers... it will not get counted.
      console.error('Incoming TNT from address not recognized as a registered Node: ' + tx.fromAddress)
      return
    }
  } catch (error) {
    console.error(`Unable to query RegisteredNodes table: ${error.message}`)
    return
  }

  try {
    // Convert the TNT to credits
    let credits = convertTntGrainsToCredit(tntGrainsAmount)
    let prevBalance = nodeToCredit.tntCredit
    await nodeToCredit.increment({ tntCredit: credits })
    console.log(`Issued ${credits} credits to Node ${nodeToCredit.tntAddr} with previous balance of ${prevBalance}, new balance is ${nodeToCredit.tntCredit}`)
  } catch (error) {
    console.error(`Unable to issue credits to Node ${nodeToCredit.tntAddr}: ${error.message}`)
  }
}

/**
 * Converts TNT token amount (in grains) to credit value
 * @param  {number} tntAmount Grains of TNT to convert
 * @return {number}           Amount of credits
 */
function convertTntGrainsToCredit (tntGrainsAmount) {
  return new BigNumber(tntGrainsAmount).times(env.TNT_TO_CREDIT_RATE).dividedBy(10 ** 8).toNumber()
}

/**
 * Check if the latestEventInfo comes after the block info in newEventInfo.
 *
 * @param {obj} latestEventInfo
 * @param {obj} newEventInfo
 */
function isNewEventOlder (latestEventInfo, newEventInfo) {
  // Check block number
  if (latestEventInfo.blockNumber > newEventInfo.blockNumber) {
    return true
  }

  // If block number is the same, check trx index
  if (latestEventInfo.blockNumber === newEventInfo.blockNumber &&
    latestEventInfo.transactionIndex > newEventInfo.transactionIndex) {
    return true
  }

  return false
}

/**
 * Initializes the token listener for incoming TNT token transfers.
 */
async function initListenerAsync () {
  // Get the last known event info and save it to a local var
  lastEventInfo = await getLastKnownEventInfoAsync()

  let listenAddresses = env.ETH_TNT_LISTEN_ADDRS.split(',')

  console.log('Listening for incoming TNT tokens to: ' + listenAddresses + ' starting at block ' + JSON.stringify(lastEventInfo))

  // Start listening for incoming transactions
  ops.watchForTransfers(listenAddresses, lastEventInfo.blockNumber, incomingTokenTransferEvent)
}

/**
 * This is the callback fired when a transfer of TNT tokens is found
 * to come to the account[0] on the web3 provider.
 *
 * @param {obj} error
 * @param {obj} params
 */
function incomingTokenTransferEvent (error, params) {
  // Check for error
  if (error) {
    console.error(error)
    process.exit(-1)
  }

  // Ensure it is not before the last seen trx
  if (isNewEventOlder(lastEventInfo, params)) {
    console.warn('Found an event that should have already been processed: ')
    console.warn(params)
    return
  } else {
    // Save off the last seen info to the local copy
    lastEventInfo = {
      blockNumber: params.blockNumber,
      transactionIndex: params.transactionIndex
    }
  }

  // process this new transaction information
  // log the transaction and assign proper TNT credits to sender address
  processNewTxAsync(params)
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync (callback) {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await ethTokenTxSequelize.sync({ logging: false })
      await registeredNodeSequelize.sync({ logging: false })
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
    // Init the token objects
    console.log('Calling loadProvider: ' + env.ETH_PROVIDER_URI)
    web3Provider = loadProvider(env.ETH_PROVIDER_URI)
    console.log('Calling loadToken')
    tokenContract = await loadToken(web3Provider, env.ETH_TNT_TOKEN_ADDR)
    ops = new TokenOps(tokenContract)

    // init DB
    await openStorageConnectionAsync()

    // init event listener
    await initListenerAsync()

    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started - wait 10 seconds for contracts to be deployed
setTimeout(start, 10000)

// export these functions for unit tests
module.exports = {
  isNewEventOlder: isNewEventOlder
}
