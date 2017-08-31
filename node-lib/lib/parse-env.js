const envalid = require('envalid')

const validateAggInterval = envalid.makeValidator(x => {
  if (x >= 250 && x <= 10000) return x
  else throw new Error('Value must be between 250 and 10000, inclusive')
})
const validateFinInterval = envalid.makeValidator(x => {
  if (x >= 250 && x <= 10000) return x
  else throw new Error('Value must be between 250 and 10000, inclusive')
})
const validateMaxHashes = envalid.makeValidator(x => {
  if (x >= 100 && x <= 25000) return x
  else throw new Error('Value must be between 100 and 25000, inclusive')
})
const validateMonitorRange = envalid.makeValidator(x => {
  if (x >= 10 && x <= 600) return x
  else throw new Error('Value must be between 10 and 600, inclusive')
})
const validateMinConfirmRange = envalid.makeValidator(x => {
  if (x >= 1 && x <= 16) return x
  else throw new Error('Value must be between 1 and 16, inclusive')
})
const validateFactorOfSixty = envalid.makeValidator(x => {
  if (60 % x === 0) return x
  else throw new Error('Value must be a factor of 60')
})
const validateETHAddress = envalid.makeValidator(x => {
  if (/^0x[0-9a-f]{40}$/i.test(x)) return x
  else throw new Error('Value must be a well formatted Ethereum address')
})

let envDefinitions = {
  // The following variables are exposed by this stack's /config endpoint
  //
  // CHAINPOINT_CORE_BASE_URI: Base URI for this Chainpoint Core stack of services
  // ANCHOR_BTC: flag for enabling and disabling BTC anchoring
  // ANCHOR_ETH: flag for enabling and disabling ETH anchoring
  // PROOF_EXPIRE_MINUTES: The lifespan of stored proofs, in minutes
  // GET_PROOFS_MAX_REST: The maximum number of proofs that can be requested in one GET /proofs request
  // GET_PROOFS_MAX_WS: The maximum number of proofs that can be requested/subscribed to in one call
  // POST_VERIFY_PROOFS_MAX: The maximum number of proofs allowed to be verified in one request
  // GET_CALENDAR_BLOCKS_MAX: The maximum number of calendar blocks allowed to be retrieved in one request

  // ***********************************************************************
  // * Global variables with default values
  // ***********************************************************************

  // Chainpoint stack related variables
  NODE_ENV: envalid.str({ default: 'production', desc: 'The type of environment in which the service is running' }),

  // Proof retention setting
  PROOF_EXPIRE_MINUTES: envalid.num({ default: 1440, desc: 'The lifespan of stored proofs, in minutes' }),

  // Anchor to external blockchains toggle variables
  // Using string values in place of a Bool due to issues with storing bool values in K8s secrets
  ANCHOR_BTC: envalid.str({ choices: ['enabled', 'disabled'], default: 'disabled', desc: 'String flag for enabling and disabling BTC anchoring' }),
  ANCHOR_ETH: envalid.str({ choices: ['enabled', 'disabled'], default: 'disabled', desc: 'String flag for enabling and disabling ETH anchoring' }),

  // Consul related variables and keys
  CONSUL_HOST: envalid.str({ default: 'consul', desc: 'Consul server host' }),
  CONSUL_PORT: envalid.num({ default: 8500, desc: 'Consul server port' }),
  NIST_KEY: envalid.str({ default: 'service/nist/latest', desc: 'The consul key to write to, watch to receive updated NIST object' }),
  CALENDAR_LOCK_KEY: envalid.str({ default: 'service/calendar/blockchain/lock', desc: 'Key used for acquiring calendar write locks' }),

  // RabbitMQ related variables
  RABBITMQ_CONNECT_URI: envalid.url({ default: 'amqp://chainpoint:chainpoint@rabbitmq', desc: 'Connection string w/ credentials for RabbitMQ' }),
  RMQ_WORK_OUT_STATE_QUEUE: envalid.str({ default: 'work.state', desc: 'The queue name for outgoing message to the proof state service' }),
  RMQ_WORK_OUT_CAL_QUEUE: envalid.str({ default: 'work.cal', desc: 'The queue name for outgoing message to the calendar service' }),
  RMQ_WORK_OUT_AGG_QUEUE: envalid.str({ default: 'work.agg', desc: 'The queue name for outgoing message to the aggregator service' }),
  RMQ_WORK_OUT_BTCTX_QUEUE: envalid.str({ default: 'work.btctx', desc: 'The queue name for outgoing message to the btc tx service' }),
  RMQ_WORK_OUT_BTCMON_QUEUE: envalid.str({ default: 'work.btcmon', desc: 'The queue name for outgoing message to the btc mon service' }),
  RMQ_WORK_OUT_GEN_QUEUE: envalid.str({ default: 'work.gen', desc: 'The queue name for outgoing message to the proof gen service' }),
  RMQ_WORK_OUT_API_QUEUE: envalid.str({ default: 'work.api', desc: 'The queue name for outgoing message to the api service' }),

  // Redis related variables
  REDIS_CONNECT_URI: envalid.url({ default: 'redis://redis:6379', desc: 'The Redis server connection URI' }),

  // Postgres related variables
  POSTGRES_CONNECT_PROTOCOL: envalid.str({ default: 'postgres:', desc: 'Postgres server connection protocol' }),
  POSTGRES_CONNECT_USER: envalid.str({ default: 'chainpoint', desc: 'Postgres server connection user name' }),
  POSTGRES_CONNECT_PW: envalid.str({ default: 'chainpoint', desc: 'Postgres server connection password' }),
  POSTGRES_CONNECT_HOST: envalid.str({ default: 'postgres', desc: 'Postgres server connection host' }),
  POSTGRES_CONNECT_PORT: envalid.num({ default: 5432, desc: 'Postgres server connection port' }),
  POSTGRES_CONNECT_DB: envalid.str({ default: 'chainpoint', desc: 'Postgres server connection database name' }),

  // Service Specific Variables

  // Aggregator service specific variables
  RMQ_PREFETCH_COUNT_AGG: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_AGG_QUEUE: envalid.str({ default: 'work.agg', desc: 'The queue name for message consumption originating from the api service' }),
  AGGREGATION_INTERVAL: validateAggInterval({ default: 1000, desc: 'The frequency of the aggregation process, in milliseconds' }),
  FINALIZATION_INTERVAL: validateFinInterval({ default: 250, desc: 'The frequency of the finalization of trees and delivery to state service, in milliseconds' }),
  HASHES_PER_MERKLE_TREE: validateMaxHashes({ default: 25000, desc: 'The maximum number of hashes to be used when constructing an aggregation tree' }),

  // API service specific variables
  RMQ_PREFETCH_COUNT_API: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_API_QUEUE: envalid.str({ default: 'work.api', desc: 'The queue name for message consumption originating from proof gen service' }),
  RMQ_INCOMING_EXCHANGE: envalid.str({ default: 'exchange.headers', desc: 'The exchange for receiving messages from proof gen service' }),
  GET_PROOFS_MAX_REST: envalid.num({ default: 250, desc: 'The maximum number of proofs that can be requested in one GET /proofs request' }),
  GET_PROOFS_MAX_WS: envalid.num({ default: 250, desc: 'The maximum number of proofs that can be requested/subscribed to in one call' }),
  MAX_BODY_SIZE: envalid.num({ default: 131072, desc: 'Max body size in bytes for incoming requests' }),
  POST_VERIFY_PROOFS_MAX: envalid.num({ default: 1000, desc: 'The maximum number of proofs allowed to be verified in one request' }),
  GET_CALENDAR_BLOCKS_MAX: envalid.num({ default: 1000, desc: 'The maximum number of calendar blocks allowed to be retrieved in one request' }),

  // BTC Mon service specific variables
  RMQ_PREFETCH_COUNT_BTCMON: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_BTCMON_QUEUE: envalid.str({ default: 'work.btcmon', desc: 'The queue name for message consumption originating from the calendar service' }),
  MONITOR_INTERVAL_SECONDS: validateMonitorRange({ default: 30, desc: 'The frequency that transactions are monitored for new confirmations, in seconds' }),
  MIN_BTC_CONFIRMS: validateMinConfirmRange({ default: 6, desc: 'The number of confirmations needed before the transaction is considered ready for proof delivery' }),

  // BTC Tx service specific variables
  RMQ_PREFETCH_COUNT_BTCTX: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_BTCTX_QUEUE: envalid.str({ default: 'work.btctx', desc: 'The queue name for message consumption originating from the calendar service' }),
  // This is to safeguard against the service returning a very high value in error
  // and to impose a common sense limit on the highest fee per byte to allow.
  // MAX BTC to spend = AverageTxSizeBytes * BTC_MAX_FEE_SAT_PER_BYTE / 100000000
  // If we are to limit the maximum fee per transaction to 0.01 BTC, then
  // 0.01 = 235 * BTC_MAX_FEE_SAT_PER_BYTE / 100000000
  // BTC_MAX_FEE_SAT_PER_BYTE = 0.01 *  100000000 / 235
  // BTC_MAX_FEE_SAT_PER_BYTE = 4255
  BTC_MAX_FEE_SAT_PER_BYTE: envalid.num({ default: 4255, desc: 'The maximum feeRateSatPerByte value accepted' }),

  // Calendar service specific variables
  RMQ_PREFETCH_COUNT_CAL: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_CAL_QUEUE: envalid.str({ default: 'work.cal', desc: 'The queue name for message consumption originating from the aggregator, btc-tx, and btc-mon services' }),
  CALENDAR_INTERVAL_MS: envalid.num({ default: 10000, desc: 'The frequency to generate new calendar blocks, defaults to 10 seconds' }),
  ANCHOR_BTC_PER_HOUR: validateFactorOfSixty({ default: 2, desc: 'The number of times per hour to generate new btc-a blocks and btc anchoring, defaults to 2, must be a factor of 60' }),
  ANCHOR_ETH_PER_HOUR: validateFactorOfSixty({ default: 2, desc: 'The number of times per hour to generate new eth-a blocks and eth anchoring, defaults to 2, must be a factor of 60' }),

  // NIST beacon service specific variables
  NIST_INTERVAL_MS: envalid.num({ default: 60000, desc: 'The frequency to get latest NIST beacon data, in milliseconds' }),

  // Proof Gen service specific variables
  RMQ_PREFETCH_COUNT_GEN: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_GEN_QUEUE: envalid.str({ default: 'work.gen', desc: 'The queue name for message consumption originating from the proof state service' }),
  RMQ_OUTGOING_EXCHANGE: envalid.str({ default: 'exchange.headers', desc: 'The exchange for publishing messages bound for API Service instances' }),

  // Proof State service specific variables
  RMQ_PREFETCH_COUNT_STATE: envalid.num({ default: 10, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_STATE_QUEUE: envalid.str({ default: 'work.state', desc: 'The queue name for message consumption originating from the aggregator, calendar, and proof state services' }),
  PRUNE_FREQUENCY_MINUTES: envalid.num({ default: 1, desc: 'The frequency that the proof state and hash tracker log tables have their old, unneeded data pruned, in minutes' }),

  // ETH TNT Listener / TNT TX services specific variables
  ETH_PROVIDER_URI: envalid.url({ default: 'http://testrpc:8545', desc: 'URI to the ETH node provider.' }),
  LISTEN_TX_PORT: envalid.num({ default: 8085, desc: 'Port of the ETH provider.' }),
  TNT_TO_CREDIT_RATE: envalid.num({ default: 5000, desc: 'Exchange rate for TNT tokens to Credits. Default is give 5000 credits for each TNT token.' }),
  ETH_TNT_TX_CONNECT_URI: envalid.url({ default: 'http://eth-tnt-tx-service:8085', desc: 'The eth-tnt-tx-service REST connection URI' }),
  ETH_WALLET_PATH: envalid.str({ default: '', desc: 'The relative path to the wallet file.  Leave empty to not use a wallet for transactions.' }),
  ETH_WALLET_PASSWORD: envalid.str({ default: '', desc: 'The password to unlock the wallet file.  Do not specify if no wallet is used.' }),

  // TNT Reward service specific variables
  REWARDS_PER_HOUR: validateFactorOfSixty({ default: 2, desc: 'The number of times per hour to calculate and distribute rewards, defaults to 2, must be a factor of 60' }),
  MIN_CONSECUTIVE_AUDIT_PASSES_FOR_REWARD: envalid.num({ default: 4, desc: 'The minimum number of consecutive audits, where all tests pass, that must occur to be eligible for a reward' }),
  MIN_TNT_GRAINS_BALANCE_FOR_REWARD: envalid.num({ default: 300000000000, desc: 'The minimum balance of TNT, in Grains, that an address must contain in order to be eligible for a reward' })
}

module.exports = (service) => {
  // Load and validate service specific require variables as needed
  switch (service) {
    case 'api':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      break
    case 'cal':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.SIGNING_SECRET_KEY = envalid.str({ desc: 'A Base64 encoded NaCl secret signing key' })
      break
    case 'btc-mon':
      envDefinitions.INSIGHT_API_BASE_URI = envalid.url({ desc: 'The Bitcore Insight-API base URI' })
      break
    case 'btc-tx':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.INSIGHT_API_BASE_URI = envalid.url({ desc: 'The Bitcore Insight-API base URI' })
      envDefinitions.BITCOIN_WIF = envalid.str({ desc: 'The Bitcoin private key WIF used for transaction creation' })
      break
    case 'eth-tnt-listener':
      envDefinitions.ETH_TNT_LISTEN_ADDRS = envalid.str({ desc: 'The addresses used to listen for incoming TNT transfers.  If more that one, separate by commas.' })
      break
    case 'tnt-reward':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.CORE_REWARD_ETH_ADDR = validateETHAddress({ desc: 'A valid Ethereum address that the Core may receive Core rewards with' })
      envDefinitions.CORE_REWARD_ELIGIBLE = envalid.bool({ desc: 'Boolean indicating if this Core may receive Core TNT rewards' })
      break
  }
  return envalid.cleanEnv(process.env, envDefinitions, {
    strict: true
  })
}
