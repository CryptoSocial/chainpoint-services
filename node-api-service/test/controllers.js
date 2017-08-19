/* global describe, it */

process.env.NODE_ENV = 'test'

// test related packages
const expect = require('chai').expect
const request = require('supertest')
const crypto = require('crypto')
const moment = require('moment')
const uuidTime = require('uuid-time')
const BLAKE2s = require('blake2s-js')

const app = require('../server')
const server = app.server
const hashes = require('../lib/endpoints/hashes')

describe('Home Controller', () => {
  describe('GET /', () => {
    it('should return teapot error', (done) => {
      request(server)
        .get('/')
        .expect('Content-type', /json/)
        .expect(418)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('ImATeapotError')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('This is an API endpoint. Please consult https://chainpoint.org')
          done()
        })
    })
  })
})

describe('Proofs Controller', () => {
  describe('GET /proofs/hash_id', () => {
    it('should return proper error with bad hash_id', (done) => {
      request(server)
        .get('/proofs/badid')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, bad hash_id')
          done()
        })
    })

    it('should return success with valid hash_id', (done) => {
      app.setRedis({
        get: (id, callback) => {
          callback(null, '{ "chainpoint": "proof" }')
        }
      })
      request(server)
        .get('/proofs/d4f0dc90-2f55-11e7-b598-41e628860234')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body.length).to.equal(1)
          expect(res.body[0]).to.have.property('hash_id')
            .and.to.be.a('string')
            .and.to.equal('d4f0dc90-2f55-11e7-b598-41e628860234')
          expect(res.body[0]).to.have.property('proof')
          done()
        })
    })
  })

  describe('GET /proofs/', () => {
    it('should return proper error with no hash_id', (done) => {
      request(server)
        .get('/proofs/')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, at least one hash id required')
          done()
        })
    })

    it('should return proper error with too many hashids', (done) => {
      request(server)
        .get('/proofs/')
        .set('Content-type', 'text/plain')
        .set('hashids', 'a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,' +
        'a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,' +
        'a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,' +
        'a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,' +
        'a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,' +
        'a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, too many hash ids (250 max)')
          done()
        })
    })

    it('should return success with one valid hash_id in hashids', (done) => {
      app.setRedis({
        get: (id, callback) => {
          callback(null, '{ "chainpoint": "proof" }')
        }
      })
      request(server)
        .get('/proofs/')
        .set('Content-type', 'text/plain')
        .set('hashids', 'd4f0dc90-2f55-11e7-b598-41e628860234')
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body.length).to.equal(1)
          expect(res.body[0]).to.have.property('hash_id')
            .and.to.be.a('string')
            .and.to.equal('d4f0dc90-2f55-11e7-b598-41e628860234')
          expect(res.body[0]).to.have.property('proof')
          done()
        })
    })

    it('should return success with multiple valid hash_ids in hashids', (done) => {
      app.setRedis({
        get: (id, callback) => {
          callback(null, '{ "chainpoint": "proof" }')
        }
      })
      request(server)
        .get('/proofs/')
        .set('Content-type', 'text/plain')
        .set('hashids', 'd4f0dc90-2f55-11e7-b598-41e628860234, d4f0dc90-2f55-11e7-b598-41e628860234')
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body.length).to.equal(2)
          expect(res.body[0]).to.have.property('hash_id')
            .and.to.be.a('string')
            .and.to.equal('d4f0dc90-2f55-11e7-b598-41e628860234')
          expect(res.body[0]).to.have.property('proof')
          expect(res.body[1]).to.have.property('hash_id')
            .and.to.be.a('string')
            .and.to.equal('d4f0dc90-2f55-11e7-b598-41e628860234')
          expect(res.body[1]).to.have.property('proof')
          done()
        })
    })
  })
})

describe('Hashes Controller', () => {
  describe('POST /hashes', () => {
    it('should return proper error with invalid content type', (done) => {
      request(server)
        .post('/hashes')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid content type')
          done()
        })
    })

    it('should return proper error with missing authorization key', (done) => {
      request(server)
        .post('/hashes')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: missing authorization key')
          done()
        })
    })

    it('should return proper error with bad authorization value, one string', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'qweqwe')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: bad authorization value')
          done()
        })
    })

    it('should return proper error with bad authorization value, no bearer', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'qweqwe ababababab')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: bad authorization value')
          done()
        })
    })

    it('should return proper error with bad authorization value, missing tnt-address', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: missing tnt-address key')
          done()
        })
    })

    it('should return proper error with bad authorization value, bad tnt-address', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0xbad')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: invalid tnt-address value')
          done()
        })
    })

    it('should return proper error with missing hash', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body: missing hash')
          done()
        })
    })

    it('should return proper error with hash not a string', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: ['badhash'] })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body: bad hash submitted')
          done()
        })
    })

    it('should return proper error with invalid hash', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: 'badhash' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body: bad hash submitted')
          done()
        })
    })

    it('should return proper error with no AMQP connection', (done) => {
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(500)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InternalServerError')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('Message could not be delivered')
          done()
        })
    })

    it('should return proper error with NTP < NIST value', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })
      app.setNistLatest('3002759084:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(500)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InternalServerError')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('Bad NTP time')
          done()
        })
    })

    it('should return proper error with unknown tnt-address', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      app.setNistLatest('1400585240:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      app.setHashesNodeRegistration({
        findOne: (params) => {
          return null
        }
      })
      request(server)
        .post('/hashes')
        .set('Authorization', 'bearer ababab121212')
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: unknown tnt-address')
          done()
        })
    })

    it('should return proper error with bad hmac value', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let tntAddr = '0x1234567890123456789012345678901234567890'

      let hmacKey = crypto.randomBytes(32).toString('hex')
      let hash = crypto.createHmac('sha256', hmacKey)
      let hmac = hash.update('bad').digest('hex')

      app.setNistLatest('1400585240:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      app.setHashesNodeRegistration({
        findOne: (params) => {
          return {
            tntAddr: tntAddr,
            hmacKey: hmacKey,
            tntCredit: 10
          }
        }
      })
      request(server)
        .post('/hashes')
        .set('Authorization', `bearer ${hmac}`)
        .set('tnt-address', tntAddr)
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(401)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidCredentials')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('authorization denied: bad hmac value')
          done()
        })
    })

    it('should return proper error with zero balance', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let tntAddr = '0x1234567890123456789012345678901234567890'

      let hmacKey = crypto.randomBytes(32).toString('hex')
      let hash = crypto.createHmac('sha256', hmacKey)
      let hmac = hash.update(tntAddr).digest('hex')

      app.setNistLatest('1400585240:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      app.setHashesNodeRegistration({
        findOne: (params) => {
          return {
            tntAddr: tntAddr,
            hmacKey: hmacKey,
            tntCredit: 0
          }
        }
      })
      request(server)
        .post('/hashes')
        .set('Authorization', `bearer ${hmac}`)
        .set('tnt-address', tntAddr)
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(403)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('NotAuthorized')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('insufficient tntCredit remaining : 0')
          done()
        })
    })

    it('should return a matched set of metadata and UUID embedded timestamps', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let tntAddr = '0x1234567890123456789012345678901234567890'

      let hmacKey = crypto.randomBytes(32).toString('hex')
      let hash = crypto.createHmac('sha256', hmacKey)
      let hmac = hash.update(tntAddr).digest('hex')

      app.setNistLatest('1400585240:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      app.setHashesNodeRegistration({
        findOne: (params) => {
          return {
            tntAddr: tntAddr,
            hmacKey: hmacKey,
            tntCredit: 10,
            decrement: (params) => { }
          }
        }
      })
      request(server)
        .post('/hashes')
        .set('Authorization', `bearer ${hmac}`)
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('hash_id')
          expect(res.body).to.have.property('submitted_at')
          // The UUID timestamp has ms level precision, ISO8601 only to the second.
          // Check that they are within 1000ms of each other.
          expect(uuidTime.v1(res.body.hash_id) - Date.parse(res.body.submitted_at)).to.be.within(0, 1000)
          done()
        })
    })

    it('should return a v1 UUID node embedded with a partial SHA256 over timestamp and hash', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let tntAddr = '0x1234567890123456789012345678901234567890'

      let hmacKey = crypto.randomBytes(32).toString('hex')
      let hash = crypto.createHmac('sha256', hmacKey)
      let hmac = hash.update(tntAddr).digest('hex')

      app.setNistLatest('1400585240:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      app.setHashesNodeRegistration({
        findOne: (params) => {
          return {
            tntAddr: tntAddr,
            hmacKey: hmacKey,
            tntCredit: 10,
            decrement: (params) => { }
          }
        }
      })
      request(server)
        .post('/hashes')
        .set('Authorization', `bearer ${hmac}`)
        .set('tnt-address', '0x1234567890123456789012345678901234567890')
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('hash_id')
          // Knowing the original hash, the timestamp from the UUID, the
          // latest available NIST data, and the personalization bytes,
          // you should be able to calculate whether the UUID 'Node ID'
          // data segment is the 5 byte BLAKE2s hash of the timestamp
          // embedded in the UUID and the hash submitted to get this UUID.
          let t = uuidTime.v1(res.body.hash_id)

          // 5 byte length BLAKE2s hash w/ personalization
          let h = new BLAKE2s(5, { personalization: Buffer.from('CHAINPNT') })
          let hashStr = [
            t.toString(),
            t.toString().length,
            res.body.hash,
            res.body.hash.length,
            res.body.nist,
            res.body.nist.length
          ].join(':')

          h.update(Buffer.from(hashStr))
          let shortHashNodeBuf = Buffer.concat([Buffer.from([0x01]), h.digest()])
          // Last segment of UUIDv1 contains BLAKE2s hash to be matched
          expect(res.body.hash_id.split('-')[4]).to.equal(shortHashNodeBuf.toString('hex'))
          done()
        })
    })

    it('should return proper result with valid call', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let tntAddr = '0x1234567890123456789012345678901234567890'

      let hmacKey = crypto.randomBytes(32).toString('hex')
      let hash = crypto.createHmac('sha256', hmacKey)
      let hmac = hash.update(tntAddr).digest('hex')

      app.setNistLatest('1400585240:8E00C0AF2B68E33CC453BF45A1689A6804700C083478FEB34E4694422999B6F745C2F837D7BA983F9D7BA52F7CC62965B8E1B7384CD8177003B5D3A0D099D93C')
      app.setHashesNodeRegistration({
        findOne: (params) => {
          return {
            tntAddr: tntAddr,
            hmacKey: hmacKey,
            tntCredit: 10,
            decrement: (params) => { }
          }
        }
      })
      request(server)
        .post('/hashes')
        .set('Authorization', `bearer ${hmac}`)
        .set('tnt-address', tntAddr)
        .send({ hash: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res).to.have.property('body')
          expect(res.body).to.have.property('hash_id')
          expect(res.body).to.have.property('hash').and.to.equal('ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12')
          expect(res.body).to.have.property('nist')
          expect(res.body).to.have.property('submitted_at')
          expect(res.body).to.have.property('processing_hints')
          expect(res.body.processing_hints).to.have.property('cal').and.to.be.a('string')
          expect(res.body.processing_hints).to.have.property('eth').and.to.be.a('string')
          expect(res.body.processing_hints).to.have.property('btc').and.to.be.a('string')
          done()
        })
    })
  })
})

describe('Calendar Controller', () => {
  describe('GET /calendar/height', () => {
    it('should return proper error with bad height', (done) => {
      request(server)
        .get('/calendar/badheight')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, height must be a positive integer')
          done()
        })
    })
  })

  describe('GET /calendar/height', () => {
    it('should return proper error with negative height', (done) => {
      request(server)
        .get('/calendar/-1')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, height must be a positive integer')
          done()
        })
    })
  })

  describe('GET /calendar/height/data', () => {
    it('should return proper error with bad height', (done) => {
      request(server)
        .get('/calendar/badheight/data')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, height must be a positive integer')
          done()
        })
    })

    it('should return proper error with negative height', (done) => {
      request(server)
        .get('/calendar/-2/data')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, height must be a positive integer')
          done()
        })
    })
  })

  describe('GET /calendar/height/hash', () => {
    it('should return proper error with bad height', (done) => {
      request(server)
        .get('/calendar/badheight/hash')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, height must be a positive integer')
          done()
        })
    })

    it('should return proper error with negative height', (done) => {
      request(server)
        .get('/calendar/-2/hash')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, height must be a positive integer')
          done()
        })
    })
  })

  describe('GET /calendar/fromHeight/toHeight', () => {
    it('should return proper error with bad fromheight', (done) => {
      request(server)
        .get('/calendar/badheight/3')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, fromHeight must be a positive integer')
          done()
        })
    })

    it('should return proper error with negative fromheight', (done) => {
      request(server)
        .get('/calendar/-1/3')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, fromHeight must be a positive integer')
          done()
        })
    })

    it('should return proper error with bad toheight', (done) => {
      request(server)
        .get('/calendar/1/badheight')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, toHeight must be a positive integer')
          done()
        })
    })
    it('should return proper error with negative toheight', (done) => {
      request(server)
        .get('/calendar/1/-1')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, toHeight must be a positive integer')
          done()
        })
    })

    it('should return proper error with from > to', (done) => {
      request(server)
        .get('/calendar/100/50')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, toHeight must be greater or equal to fromHeight')
          done()
        })
    })

    it('should return proper error with range too large', (done) => {
      request(server)
        .get('/calendar/1/9999')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid request, requested range may not exceed 1000 blocks')
          done()
        })
    })
  })
})

describe('Verify Controller', () => {
  describe('POST /verify', () => {
    it('should return proper error with invalid content type', (done) => {
      request(server)
        .post('/verify')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid content type')
          done()
        })
    })

    it('should return proper error with missing proofs', (done) => {
      request(server)
        .post('/verify')
        .send({ name: 'Manny' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, missing proofs')
          done()
        })
    })

    it('should return proper error with bad proofs array', (done) => {
      request(server)
        .post('/verify')
        .send({ proofs: 'Manny' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, proofs is not an Array')
          done()
        })
    })

    it('should return proper error with empty proofs array', (done) => {
      request(server)
        .post('/verify')
        .send({ proofs: [] })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, proofs Array is empty')
          done()
        })
    })

    it('should return proper error with too many proofs', (done) => {
      let proofs = []
      for (let x = 0; x < 1100; x++) {
        proofs.push('proof')
      }

      request(server)
        .post('/verify')
        .send({ proofs: proofs })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, proofs Array max size of 1000 exceeded')
          done()
        })
    })
  })
})

describe('Config Controller', () => {
  app.config.setRedis({
    getAsync: async () => {
      return 'qwe:qwe:qwe:qwe:qwe'
    }
  })
  app.config.setCalendarBlock({
    findOne: async () => {
      return { id: 27272 }
    }
  })
  describe('GET /config', () => {
    it('should return proper config object', (done) => {
      request(server)
        .get('/config')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('chainpoint_core_base_uri').and.to.equal('http://test.chainpoint.org')
          expect(res.body).to.have.property('anchor_btc')
          expect(res.body).to.have.property('anchor_eth')
          expect(res.body).to.have.property('proof_expire_minutes')
          expect(res.body).to.have.property('get_proofs_max_rest')
          expect(res.body).to.have.property('get_proofs_max_ws')
          expect(res.body).to.have.property('post_verify_proofs_max')
          expect(res.body).to.have.property('get_calendar_blocks_max')
          expect(res.body).to.have.property('time')
          expect(res.body).to.have.property('public_keys')
          expect(res.body).to.have.property('calendar')
          expect(res.body.calendar).to.have.property('height')
          expect(res.body.calendar).to.have.property('audit_challenge')
          done()
        })
    })
  })
})

describe('Nodes Controller', () => {
  describe('POST /nodes', () => {
    it('should return proper error with invalid content type', (done) => {
      request(server)
        .post('/nodes')
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid content type')
          done()
        })
    })

    it('should return error with no tnt_addr', (done) => {
      request(server)
        .post('/nodes')
        .send({ public_uri: 'http://127.0.0.1' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, missing tnt_addr')
          done()
        })
    })

    it('should return error with empty tnt_addr', (done) => {
      request(server)
        .post('/nodes')
        .send({ tnt_addr: '', public_uri: 'http://127.0.0.1' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, empty tnt_addr')
          done()
        })
    })

    it('should return error with malformed tnt_addr', (done) => {
      request(server)
        .post('/nodes')
        .send({ tnt_addr: '0xabc', public_uri: 'http://127.0.0.1' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, malformed tnt_addr')
          done()
        })
    })

    it('should return error with empty public_uri', (done) => {
      request(server)
        .post('/nodes')
        .send({ tnt_addr: '0x' + crypto.randomBytes(20).toString('hex'), public_uri: '' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, invalid empty public_uri, remove if non-public IP')
          done()
        })
    })

    it('should return error if a tnt_addr already exists', (done) => {
      let publicUri = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')

      let data = []

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: crypto.randomBytes(32).toString('hex')
          }
          data.push(row)
          return row
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri })
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          request(server)
            .post('/nodes')
            .send({ tnt_addr: tntAddr1, public_uri: publicUri })
            .expect(409)
            .end((err, res) => {
              expect(err).to.equal(null)
              expect(res.body).to.have.property('code')
                .and.to.be.a('string')
                .and.to.equal('ConflictError')
              expect(res.body).to.have.property('message')
                .and.to.be.a('string')
                .and.to.equal('tnt_addr : address already exists')
              done()
            })
        })
    })

    it('should be OK if a public_uri is registered twice', (done) => {
      let publicUri = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let tntAddr2 = '0x' + crypto.randomBytes(20).toString('hex')

      let data = []

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: crypto.randomBytes(32).toString('hex')
          }
          data.push(row)
          return row
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri })
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          request(server)
            .post('/nodes')
            .send({ tnt_addr: tntAddr2, public_uri: publicUri })
            .expect(200)
            .end((err, res) => {
              expect(err).to.equal(null)
              done()
            })
        })
    })

    it('should return OK for valid request', (done) => {
      let publicUri = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let hmacKey = crypto.randomBytes(32).toString('hex')

      let data = []

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: hmacKey
          }
          data.push(row)
          return row
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri })
        .expect('Content-type', /json/)
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('tnt_addr').and.to.equal(tntAddr1)
          expect(res.body).to.have.property('public_uri').and.to.equal(publicUri)
          expect(res.body).to.have.property('hmac_key').and.to.equal(hmacKey)
          done()
        })
    })
  })

  describe('PUT /nodes', () => {
    it('should return proper error with invalid content type', (done) => {
      let randTntAddr = '0x' + crypto.randomBytes(20).toString('hex')

      request(server)
        .put('/nodes/' + randTntAddr)
        .set('Content-type', 'text/plain')
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid content type')
          done()
        })
    })

    it('should return error with malformed tnt_addr', (done) => {
      let randTntAddr = '0xzxczxc'

      request(server)
        .put('/nodes/' + randTntAddr)
        .send({ public_uri: 'http://127.0.0.1' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, malformed tnt_addr')
          done()
        })
    })

    it('should return error with malformed public_uri', (done) => {
      let randTntAddr = '0x' + crypto.randomBytes(20).toString('hex')
      let publicUri = 'baduri'

      request(server)
        .put('/nodes/' + randTntAddr)
        .send({ public_uri: publicUri })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, invalid public_uri')
          done()
        })
    })

    it('should return error with missing hmac', (done) => {
      let randTntAddr = '0x' + crypto.randomBytes(20).toString('hex')
      let publicUri = 'http://127.0.0.1'

      request(server)
        .put('/nodes/' + randTntAddr)
        .send({ public_uri: publicUri })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, missing hmac')
          done()
        })
    })

    it('should return error with empty hmac', (done) => {
      let randTntAddr = '0x' + crypto.randomBytes(20).toString('hex')
      let publicUri = 'http://127.0.0.1'

      request(server)
        .put('/nodes/' + randTntAddr)
        .send({ public_uri: publicUri, hmac: '' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, empty hmac')
          done()
        })
    })

    it('should return error with invalid hmac', (done) => {
      let randTntAddr = '0x' + crypto.randomBytes(20).toString('hex')
      let publicUri = 'http://127.0.0.1'

      request(server)
        .put('/nodes/' + randTntAddr)
        .send({ public_uri: publicUri, hmac: '!badhmac' })
        .expect('Content-type', /json/)
        .expect(409)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('InvalidArgument')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('invalid JSON body, invalid hmac')
          done()
        })
    })

    it('should return error for node registration not found', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let publicUri1 = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let hmacKey = crypto.randomBytes(32).toString('hex')

      let data = []
      let nodeReg = null

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: hmacKey
          }
          data.push(row)
          return row
        },
        find: (params) => {
          nodeReg = data.find((item) => { return item.tntAddr === params.where.tntAddr })
          if (nodeReg) nodeReg.save = () => { }
          return nodeReg
        }
      })

      request(server)
        .put('/nodes/' + tntAddr1)
        .send({ public_uri: publicUri1, hmac: crypto.randomBytes(32).toString('hex') })
        .expect('Content-type', /json/)
        .expect(404)
        .end((err, res) => {
          expect(err).to.equal(null)
          expect(res.body).to.have.property('code')
            .and.to.be.a('string')
            .and.to.equal('ResourceNotFound')
          expect(res.body).to.have.property('message')
            .and.to.be.a('string')
            .and.to.equal('not found')
          done()
        })
    })

    it('should return error for bad hmac', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let publicUri1 = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let hmacKey = crypto.randomBytes(32).toString('hex')

      let data = []
      let nodeReg = null

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: hmacKey
          }
          data.push(row)
          return row
        },
        find: (params) => {
          nodeReg = data.find((item) => { return item.tntAddr === params.where.tntAddr })
          if (nodeReg) nodeReg.save = () => { }
          return nodeReg
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri1 })
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)

          request(server)
            .put('/nodes/' + tntAddr1)
            .send({ public_uri: publicUri1, hmac: crypto.randomBytes(32).toString('hex') })
            .expect('Content-type', /json/)
            .expect(409)
            .end((err, res) => {
              expect(err).to.equal(null)
              expect(res.body).to.have.property('code')
                .and.to.be.a('string')
                .and.to.equal('InvalidArgument')
              expect(res.body).to.have.property('message')
                .and.to.be.a('string')
                .and.to.equal('incorrect hmac')
              done()
            })
        })
    })

    it('should return OK for valid PUT no change to tnt or IP', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let publicUri = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let hmacKey = crypto.randomBytes(32).toString('hex')

      let data = []
      let nodeReg = null

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: hmacKey
          }
          data.push(row)
          return row
        },
        find: (params) => {
          nodeReg = data.find((item) => { return item.tntAddr === params.where.tntAddr })
          if (nodeReg) nodeReg.save = () => { }
          return nodeReg
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri })
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)

          // HMAC-SHA256(hmac-key, TNT_ADDRESS|IP|YYYYMMDDHHMM)
          let hash = crypto.createHmac('sha256', res.body.hmac_key)
          let formattedDate = moment().utc().format('YYYYMMDDHHmm')
          let hmacTxt = [tntAddr1, publicUri, formattedDate].join('')
          let calculatedHMAC = hash.update(hmacTxt).digest('hex')

          request(server)
            .put('/nodes/' + tntAddr1)
            .send({ public_uri: publicUri, hmac: calculatedHMAC })
            .expect('Content-type', /json/)
            .expect(200)
            .end((err, res) => {
              expect(err).to.equal(null)
              expect(res.body).to.have.property('tnt_addr')
                .and.to.equal(tntAddr1)
              expect(res.body).to.have.property('public_uri')
                .and.to.equal(publicUri)
              done()
            })
        })
    })

    it('should return OK for valid PUT no change to tnt and updated IP', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let publicUri1 = 'http://127.0.0.1'
      let publicUri2 = 'http://127.0.0.2'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let hmacKey = crypto.randomBytes(32).toString('hex')

      let data = []
      let nodeReg = null

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: hmacKey
          }
          data.push(row)
          return row
        },
        find: (params) => {
          nodeReg = data.find((item) => { return item.tntAddr === params.where.tntAddr })
          if (nodeReg) nodeReg.save = () => { }
          return nodeReg
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri1 })
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          // HMAC-SHA256(hmac-key, TNT_ADDRESS|IP|YYYYMMDDHHMM)
          let hash = crypto.createHmac('sha256', res.body.hmac_key)
          let formattedDate = moment().utc().format('YYYYMMDDHHmm')
          let hmacTxt = [tntAddr1, publicUri2, formattedDate].join('')
          let calculatedHMAC = hash.update(hmacTxt).digest('hex')

          request(server)
            .put('/nodes/' + tntAddr1)
            .send({ public_uri: publicUri2, hmac: calculatedHMAC })
            .expect('Content-type', /json/)
            .expect(200)
            .end((err, res) => {
              expect(err).to.equal(null)
              expect(res.body).to.have.property('tnt_addr')
                .and.to.equal(tntAddr1)
              expect(res.body).to.have.property('public_uri')
                .and.to.equal(publicUri2)
              done()
            })
        })
    })

    it('should return OK for valid PUT no change to tnt and removed IP', (done) => {
      app.setAMQPChannel({
        sendToQueue: function () { }
      })

      let publicUri1 = 'http://127.0.0.1'
      let tntAddr1 = '0x' + crypto.randomBytes(20).toString('hex')
      let hmacKey = crypto.randomBytes(32).toString('hex')

      let data = []
      let nodeReg = null

      app.setNodesNodeRegistration({
        count: (params) => {
          let matches = data.filter((row) => {
            return row.tntAddr === params.where.tntAddr
          })
          return matches.length
        },
        create: (params) => {
          let row = {
            tntAddr: params.tntAddr,
            publicUri: params.publicUri,
            hmacKey: hmacKey
          }
          data.push(row)
          return row
        },
        find: (params) => {
          nodeReg = data.find((item) => { return item.tntAddr === params.where.tntAddr })
          if (nodeReg) nodeReg.save = () => { }
          return nodeReg
        }
      })

      request(server)
        .post('/nodes')
        .send({ tnt_addr: tntAddr1, public_uri: publicUri1 })
        .expect(200)
        .end((err, res) => {
          expect(err).to.equal(null)
          // HMAC-SHA256(hmac-key, TNT_ADDRESS|IP|YYYYMMDDHHMM)
          let hash = crypto.createHmac('sha256', res.body.hmac_key)
          let formattedDate = moment().utc().format('YYYYMMDDHHmm')
          let hmacTxt = [tntAddr1, '', formattedDate].join('')
          let calculatedHMAC = hash.update(hmacTxt).digest('hex')

          request(server)
            .put('/nodes/' + tntAddr1)
            .send({ hmac: calculatedHMAC })
            .expect('Content-type', /json/)
            .expect(200)
            .end((err, res) => {
              expect(err).to.equal(null)
              expect(res.body).to.have.property('tnt_addr')
                .and.to.equal(tntAddr1)
              expect(res.body).to.not.have.property('public_uri')
              done()
            })
        })
    })
  })
})

describe('Functions', () => {
  describe('calling generatePostHashResponse with one hash', () => {
    it('should return proper response object', (done) => {
      let res = hashes.generatePostHashResponse('ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12', { tntCredit: 9999 })
      expect(res).to.have.property('hash_id')
      expect(res).to.have.property('hash').and.to.equal('ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12')
      expect(res).to.have.property('submitted_at')
      expect(res).to.have.property('processing_hints')
      expect(res.processing_hints).to.have.property('cal').and.to.be.a('string')
      expect(res.processing_hints).to.have.property('eth').and.to.be.a('string')
      expect(res.processing_hints).to.have.property('btc').and.to.be.a('string')
      expect(res).to.have.property('tnt_credit_balance').and.to.equal(9999)
      done()
    })
  })
})
