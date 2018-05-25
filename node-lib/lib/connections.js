const { URL } = require('url')
const utils = require('./utils.js')

/**
 * Opens a Redis connection
 *
 * @param {string} redisURI - The connection string for the Redis instance, an Redis URI
 * @param {function} onReady - Function to call with commands to execute when `ready` event fires
 * @param {function} onError - Function to call with commands to execute  when `error` event fires
 */
function openRedisConnection (redisURIs, onReady, onError, debug) {
  const Redis = require('ioredis')

  let redisURIList = redisURIs.split(',')

  // If redisURIs contains just a single URI, treat it as a connection to a single Redis host
  // If it contains a CSV of URIs, treat it as multiple Sentinel URIs
  let redisConfigObj = null
  if (redisURIList.length === 1) {
    // this is a single Redis host URI
    let redisURL = new URL(redisURIList[0])
    redisConfigObj = {
      port: redisURL.port,          // Redis port
      host: redisURL.hostname,   // Redis host
      password: redisURL.password
    }
  } else {
    // this is a list if Redis Sentinel URIs
    let password = null
    redisConfigObj = {
      sentinels: redisURIList.map((uri) => {
        let redisURL = new URL(uri)
        // use the first password found as the password for all sentinels
        // store this value in 'password' for use in redisConfigObj
        if (!password) password = redisURL.password
        return {
          port: redisURL.port,          // Redis port
          host: redisURL.hostname  // Redis host
        }
      }),
      name: 'mymaster',
      password: password
    }
  }

  var newRedis = new Redis(redisConfigObj)

  newRedis.on('error', (err) => {
    console.error(`A redis error has occurred: ${err}`)
    newRedis.quit()
    onError()
    console.error('Redis connection lost. Attempting reconnect...')
  })

  newRedis.on('ready', () => {
    onReady(newRedis)
    logMessage('Redis connection established', debug, 'general')
  })
}

/**
 * Initializes the connection to the Resque queue when Redis is ready
 */
async function initResqueQueueAsync (redisClient, namespace, debug) {
  const nodeResque = require('node-resque')
  const exitHook = require('exit-hook')
  var connectionDetails = { redis: redisClient }

  const queue = new nodeResque.Queue({ connection: connectionDetails })
  queue.on('error', function (error) { console.error(error.message) })
  await queue.connect()

  exitHook(async () => {
    await queue.end()
  })

  logMessage('Resque queue connection established', debug, 'general')

  return queue
}

/**
 * Initializes and configures the connection to the Resque worker when Redis is ready
 */
async function initResqueWorkerAsync (redisClient, namespace, queues, minTasks, maxTasks, taskTimeout, jobs, setMWHandlers, debug) {
  const nodeResque = require('node-resque')
  const exitHook = require('exit-hook')
  var connectionDetails = { redis: redisClient }

  var multiWorkerConfig = {
    connection: connectionDetails,
    queues: queues,
    minTaskProcessors: minTasks,
    maxTaskProcessors: maxTasks
  }

  await cleanUpWorkersAndRequequeJobsAsync(nodeResque, connectionDetails, taskTimeout)

  let multiWorker = new nodeResque.MultiWorker(multiWorkerConfig, jobs, debug)

  setMWHandlers(multiWorker)

  multiWorker.start()

  exitHook(async () => {
    await multiWorker.end()
  })

  logMessage('Resque worker connection established', debug, 'general')
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync (modelSqlzArray, debug) {
  let dbConnected = false
  while (!dbConnected) {
    try {
      for (let model of modelSqlzArray) {
        await model.sync({ logging: false })
      }
      logMessage('Sequelize connection established', debug, 'general')
      dbConnected = true
    } catch (error) {
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
 * @param {string} connectionString - The connection URI for the RabbitMQ instance
 */
async function openStandardRMQConnectionAsync (amqpClient, connectURI, queues, prefetchCount, consumeObj, onInit, onClose, debug) {
  let rmqConnected = false
  while (!rmqConnected) {
    try {
      // connect to rabbitmq server
      let conn = await amqpClient.connect(connectURI)
      // create communication channel
      let chan = await conn.createConfirmChannel()
      // assert all queues supplied
      queues.forEach(queue => { chan.assertQueue(queue, { durable: true }) })
      // optionally set prefetch count
      if (prefetchCount !== null) chan.prefetch(prefetchCount)
      // optionally confifgure message consumption
      if (consumeObj !== null) chan.consume(consumeObj.queue, consumeObj.method)
      // initialize variables using new communication channel
      onInit(chan)
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        onClose()
        console.error('Connection to RabbitMQ closed.  Reconnecting in 5 seconds...')
      })
      logMessage('RabbitMQ connection established', debug, 'general')
      rmqConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

// SUPPORT FUNCTIONS ****************

async function cleanUpWorkersAndRequequeJobsAsync (nodeResque, connectionDetails, taskTimeout, debug) {
  const queue = new nodeResque.Queue({ connection: connectionDetails })
  await queue.connect()
  // Delete stuck workers and move their stuck job to the failed queue
  await queue.cleanOldWorkers(taskTimeout)
  // Get the count of jobs in the failed queue
  let failedCount = await queue.failedCount()
  // Retrieve failed jobs in batches of 100
  // First, determine the batch ranges to retrieve
  let batchSize = 100
  let failedBatches = []
  for (let x = 0; x < failedCount; x += batchSize) {
    failedBatches.push({ start: x, end: x + batchSize - 1 })
  }
  // Retrieve the failed jobs for each batch and collect in 'failedJobs' array
  let failedJobs = []
  for (let x = 0; x < failedBatches.length; x++) {
    let failedJobSet = await queue.failed(failedBatches[x].start, failedBatches[x].end)
    failedJobs = failedJobs.concat(failedJobSet)
  }
  // For each job, remove the job from the failed queue and requeue to its original queue
  for (let x = 0; x < failedJobs.length; x++) {
    logMessage(`Requeuing job: ${failedJobs[x].payload.queue} : ${failedJobs[x].payload.class} : ${failedJobs[x].error}`, debug, 'worker')
    await queue.retryAndRemoveFailed(failedJobs[x])
  }
}

function logMessage (message, debug, msgType) {
  if (debug && debug[msgType]) {
    debug[msgType](message)
  } else {
    console.log(message)
  }
}

module.exports = {
  openRedisConnection: openRedisConnection,
  initResqueQueueAsync: initResqueQueueAsync,
  initResqueWorkerAsync: initResqueWorkerAsync,
  openStorageConnectionAsync: openStorageConnectionAsync,
  openStandardRMQConnectionAsync: openStandardRMQConnectionAsync
}
