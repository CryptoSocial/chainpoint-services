/* Copyright (C) 2018 Tierion
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

const crypto = require('crypto')
const restify = require('restify')
const _ = require('lodash')
const moment = require('moment')
var validUrl = require('valid-url')
const registeredNode = require('../models/RegisteredNode.js')
const url = require('url')
const ip = require('ip')
const utils = require('../utils.js')
const semver = require('semver')
const rp = require('request-promise-native')
const tntUnits = require('../tntUnits.js')

const env = require('../parse-env.js')('api')

let registeredNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let Op = registeredNodeSequelize.Op

// The maximum  number of registered Nodes allowed
// This value is updated from consul events as changes are detected
let regNodesLimit = 0

// The number of results to return when responding to a random nodes query
const RANDOM_NODES_RESULT_LIMIT = 25

// The minimium TNT grains required to operate a Node
const minGrainsBalanceNeeded = env.MIN_TNT_GRAINS_BALANCE_FOR_REWARD

// the minimum audit passing Node version for existing registered Nodes, set by consul
let minNodeVersionExisting = null

// the minimum audit passing Node version for newly registering Nodes, set by consul
let minNodeVersionNew = null

// validate eth address is well formed
let isEthereumAddr = (address) => {
  return /^0x[0-9a-fA-F]{40}$/i.test(address)
}

let isHMAC = (hmac) => {
  return /^[0-9a-fA-F]{64}$/i.test(hmac)
}

/**
 * GET /nodes/random retrieve handler
 *
 * Retrieve a random subset of registered and healthy Nodes
 */
async function getNodesRandomV1Async (req, res, next) {
  // get a list of random healthy Nodes
  let sqlQuery = `SELECT public_uri FROM chainpoint_registered_nodes 
                  WHERE consecutive_passes > 0  
                  ORDER BY RANDOM() LIMIT ${RANDOM_NODES_RESULT_LIMIT}`
  let rndNodes = await registeredNodeSequelize.query(sqlQuery, { type: registeredNodeSequelize.QueryTypes.SELECT })

  // build well formatted result array
  rndNodes = rndNodes.map((rndNode) => {
    return {
      public_uri: rndNode.public_uri
    }
  })

  res.cache('public', { maxAge: 60 })

  // randomize results order, limit, and send
  res.send(rndNodes)
  return next()
}

/**
 * GET /nodes/blacklist retrieve handler
 *
 * Retrieve an IP blacklist that can be pulled by Nodes to
 * block connnections from abusive IPs
 */
async function getNodesBlacklistV1Async (req, res, next) {
  let list = { blacklist: [] }
  res.cache('public', { maxAge: 600 })
  res.send(list)
  return next()
}

/**
 * POST /node create handler
 *
 * Create a new registered Node
 */
async function postNodeV1Async (req, res, next) {
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  let minNodeVersionOK = false
  if (req.headers && req.headers['x-node-version']) {
    let nodeVersion = req.headers['x-node-version']
    try {
      minNodeVersionOK = semver.satisfies(nodeVersion, `>=${minNodeVersionNew}`)
    } catch (error) {
      return next(new restify.UpgradeRequiredError(`Node version ${minNodeVersionNew} or greater required`))
    }
  }
  if (!minNodeVersionOK) {
    return next(new restify.UpgradeRequiredError(`Node version ${minNodeVersionNew} or greater required`))
  }

  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  let lowerCasedTntAddrParam
  if (!isEthereumAddr(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  } else {
    lowerCasedTntAddrParam = req.params.tnt_addr.toLowerCase()
  }

  let lowerCasedPublicUri = req.params.public_uri ? req.params.public_uri.toString().toLowerCase() : null
  // if an public_uri is provided, it must be valid
  if (lowerCasedPublicUri && !_.isEmpty(lowerCasedPublicUri)) {
    if (!validUrl.isHttpUri(lowerCasedPublicUri)) {
      return next(new restify.InvalidArgumentError('invalid JSON body, invalid public_uri'))
    }

    let parsedPublicUri = url.parse(lowerCasedPublicUri)
    // ensure that hostname is an IP
    if (!utils.isIP(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must be an IP'))
    // ensure that it is not a private IP
    if (ip.isPrivate(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must not be a private IP'))
    // disallow 0.0.0.0
    if (parsedPublicUri.hostname === '0.0.0.0') return next(new restify.InvalidArgumentError('0.0.0.0 not allowed in public_uri'))
  }

  try {
    let totalCount = await RegisteredNode.count()
    if (totalCount >= regNodesLimit) {
      return next(new restify.ForbiddenError('Maximum number of Node registrations has been reached'))
    }
  } catch (error) {
    console.error(`Unable to count registered Nodes: ${error.message}`)
    return next(new restify.InternalServerError('unable to count registered Nodes'))
  }

  try {
    let count = await RegisteredNode.count({ where: { tntAddr: lowerCasedTntAddrParam } })
    if (count >= 1) {
      return next(new restify.ConflictError('the Ethereum address provided is already registered'))
    }
  } catch (error) {
    console.error(`Unable to count registered Nodes: ${error.message}`)
    return next(new restify.InternalServerError('unable to count registered Nodes'))
  }

  if (lowerCasedPublicUri && !_.isEmpty(lowerCasedPublicUri)) {
    try {
      let count = await RegisteredNode.count({ where: { publicUri: lowerCasedPublicUri } })
      if (count >= 1) {
        return next(new restify.ConflictError('the public URI provided is already registered'))
      }
    } catch (error) {
      console.error(`Unable to count registered Nodes: ${error.message}`)
      return next(new restify.InternalServerError('unable to count registered Nodes'))
    }
  }

  // check to see if the Node has the min balance required for Node operation
  try {
    let nodeBalance = await getTNTGrainsBalanceForAddressAsync(lowerCasedTntAddrParam)
    if (nodeBalance < minGrainsBalanceNeeded) {
      let minTNTBalanceNeeded = tntUnits.grainsToTNT(minGrainsBalanceNeeded)
      return next(new restify.ForbiddenError(`TNT address ${lowerCasedTntAddrParam} does not have the minimum balance of ${minTNTBalanceNeeded} TNT for Node operation`))
    }
  } catch (error) {
    return next(new restify.InternalServerError(`unable to check address balance: ${error.message}`))
  }

  // Do the registered Node count last to be as close to the creation of the record
  // as possible and avoid overrages to the extent we can.
  try {
    let totalCount = await RegisteredNode.count()
    if (totalCount >= regNodesLimit) {
      return next(new restify.ForbiddenError('Maximum number of Node registrations has been reached'))
    }
  } catch (error) {
    console.error(`Unable to count registered Nodes: ${error.message}`)
    return next(new restify.InternalServerError('unable to count registered Nodes'))
  }

  let randHMACKey = crypto.randomBytes(32).toString('hex')

  let newNode
  try {
    newNode = await RegisteredNode.create({
      tntAddr: lowerCasedTntAddrParam,
      publicUri: lowerCasedPublicUri,
      hmacKey: randHMACKey,
      tntCredit: 86400
    })
  } catch (error) {
    console.error(`Could not create RegisteredNode for ${lowerCasedTntAddrParam} at ${lowerCasedPublicUri}: ${error.message}`)
    return next(new restify.InternalServerError(`could not create RegisteredNode for ${lowerCasedTntAddrParam} at ${lowerCasedPublicUri}`))
  }

  res.send({
    tnt_addr: newNode.tntAddr,
    public_uri: newNode.publicUri,
    hmac_key: newNode.hmacKey
  })
  return next()
}

/**
 * PUT /node/:tnt_addr update handler
 *
 * Updates an existing registered Node
 */
async function putNodeV1Async (req, res, next) {
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  let minNodeVersionOK = false
  if (req.headers && req.headers['x-node-version']) {
    let nodeVersion = req.headers['x-node-version']
    try {
      minNodeVersionOK = semver.satisfies(nodeVersion, `>=${minNodeVersionExisting}`)
    } catch (error) {
      return next(new restify.UpgradeRequiredError(`Node version ${minNodeVersionExisting} or greater required`))
    }
  }
  if (!minNodeVersionOK) {
    return next(new restify.UpgradeRequiredError(`Node version ${minNodeVersionExisting} or greater required`))
  }

  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  let lowerCasedTntAddrParam
  if (!isEthereumAddr(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  } else {
    lowerCasedTntAddrParam = req.params.tnt_addr.toLowerCase()
  }

  let lowerCasedPublicUri = req.params.public_uri ? req.params.public_uri.toString().toLowerCase() : null
  // if an public_uri is provided, it must be valid
  if (lowerCasedPublicUri && !_.isEmpty(lowerCasedPublicUri)) {
    if (!validUrl.isHttpUri(lowerCasedPublicUri)) {
      return next(new restify.InvalidArgumentError('invalid JSON body, invalid public_uri'))
    }
    let parsedPublicUri = url.parse(lowerCasedPublicUri)
    // ensure that hostname is an IP
    if (!utils.isIP(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must be an IP'))
    // ensure that it is not a private IP
    if (ip.isPrivate(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must not be a private IP'))
    // disallow 0.0.0.0
    if (parsedPublicUri.hostname === '0.0.0.0') return next(new restify.InvalidArgumentError('0.0.0.0 not allowed in public_uri'))

    try {
      let count = await RegisteredNode.count({ where: { publicUri: lowerCasedPublicUri, tntAddr: { [Op.ne]: lowerCasedTntAddrParam } } })
      if (count >= 1) {
        return next(new restify.ConflictError('the public URI provided is already registered'))
      }
    } catch (error) {
      console.error(`Unable to count registered Nodes: ${error.message}`)
      return next(new restify.InternalServerError('unable to count registered Nodes'))
    }
  }

  if (!req.params.hasOwnProperty('hmac')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing hmac'))
  }

  if (_.isEmpty(req.params.hmac)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty hmac'))
  }

  if (!isHMAC(req.params.hmac)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, invalid hmac'))
  }

  try {
    let regNode = await RegisteredNode.find({ where: { tntAddr: lowerCasedTntAddrParam } })
    if (!regNode) {
      res.status(404)
      res.noCache()
      res.send({ code: 'NotFoundError', message: 'could not find registered Node' })
      return next()
    }

    // HMAC-SHA256(hmac-key, TNT_ADDRESS|IP|YYYYMMDDHHmm)
    // Forces Nodes to be within +/- 1 min of Core to generate a valid HMAC
    let formattedDateInt = parseInt(moment().utc().format('YYYYMMDDHHmm'))
    let acceptableHMACs = []
    // build an array af acceptable hmac values with -1 minute, current minute, +1 minute
    for (let x = -1; x <= 1; x++) {
      // use req.params.tnt_addr below instead of lowerCasedTntAddrParam to preserve
      // formatting submitted from Node and used in that Node's calculation
      // use req.params.public_uri below instead of lowerCasedPublicUri to preserve
      // formatting submitted from Node and used in that Node's calculation
      let formattedTimeString = (formattedDateInt + x).toString()
      let hmacTxt = [req.params.tnt_addr, req.params.public_uri, formattedTimeString].join('')
      let calculatedHMAC = crypto.createHmac('sha256', regNode.hmacKey).update(hmacTxt).digest('hex')
      acceptableHMACs.push(calculatedHMAC)
    }
    if (!_.includes(acceptableHMACs, req.params.hmac)) {
      return next(new restify.InvalidArgumentError('Invalid authentication HMAC provided - Try NTP sync'))
    }

    if (lowerCasedPublicUri == null || _.isEmpty(lowerCasedPublicUri)) {
      regNode.publicUri = null
    } else {
      regNode.publicUri = lowerCasedPublicUri
    }

    // check to see if the Node has the min balance required for Node operation
    try {
      let nodeBalance = await getTNTGrainsBalanceForAddressAsync(lowerCasedTntAddrParam)
      if (nodeBalance < minGrainsBalanceNeeded) {
        let minTNTBalanceNeeded = tntUnits.grainsToTNT(minGrainsBalanceNeeded)
        return next(new restify.ForbiddenError(`TNT address ${lowerCasedTntAddrParam} does not have the minimum balance of ${minTNTBalanceNeeded} TNT for Node operation`))
      }
    } catch (error) {
      return next(new restify.InternalServerError(`unable to check address balance: ${error.message}`))
    }

    await regNode.save()
  } catch (error) {
    console.error(`Could not update RegisteredNode: ${error.message}`)
    return next(new restify.InternalServerError('could not update RegisteredNode'))
  }

  res.send({
    tnt_addr: lowerCasedTntAddrParam,
    public_uri: req.params.public_uri
  })
  return next()
}

function updateRegNodesLimit (count) {
  try {
    let newRegNodesLimit = parseInt(count)
    if (!(newRegNodesLimit >= 0) || newRegNodesLimit === null) throw new Error('Bad regNodesLimit value')
    regNodesLimit = newRegNodesLimit
    console.log(`Registered Nodes limit updated to ${count}`)
  } catch (error) {
    // the regNodesLimit value being set must be bad
    console.error(error.message)
  }
}

let getTNTGrainsBalanceForAddressAsync = async (tntAddress) => {
  let options = {
    headers: [
      {
        name: 'Content-Type',
        value: 'application/json'
      }
    ],
    method: 'GET',
    uri: `${env.ETH_TNT_TX_CONNECT_URI}/balance/${tntAddress}`,
    json: true,
    gzip: true,
    timeout: 10000,
    resolveWithFullResponse: true
  }

  try {
    let balanceResponse = await rp(options)
    let balanceTNTGrains = balanceResponse.body.balance
    let intBalance = parseInt(balanceTNTGrains)
    if (intBalance >= 0) {
      return intBalance
    } else {
      throw new Error(`Bad TNT balance value: ${balanceTNTGrains}`)
    }
  } catch (error) {
    throw new Error(`TNT balance read error: ${error.message}`)
  }
}

module.exports = {
  getRegisteredNodeSequelize: () => { return registeredNodeSequelize },
  getNodesRandomV1Async: getNodesRandomV1Async,
  getNodesBlacklistV1Async: getNodesBlacklistV1Async,
  postNodeV1Async: postNodeV1Async,
  putNodeV1Async: putNodeV1Async,
  setNodesRegisteredNode: (regNode) => { RegisteredNode = regNode },
  setRegNodesLimit: (val) => { updateRegNodesLimit(val) },
  setLimitDirect: (val) => { regNodesLimit = val },
  overrideGetTNTGrainsBalanceForAddressAsync: (func) => { getTNTGrainsBalanceForAddressAsync = func },
  setMinNodeVersionExisting: (v) => { minNodeVersionExisting = v },
  setMinNodeVersionNew: (v) => { minNodeVersionNew = v }
}
