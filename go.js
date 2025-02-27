#!/usr/bin/env node

const progress = require('cli-progress')
const chalk = require('chalk')

const fs = require('fs').promises
const path = require('path')

const mkdirp = require('./lib/mkdirp')

const BAR_OPTS = {
  format: chalk.cyan('{bar}') +
    chalk.grey(' | {percentage}% | {received}/{size}'),
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
}

function toBarPayload(obj) {
  const result = {}
  for (let key of ['received', 'size']) {
    result[key] = (obj[key] / 1024 / 1024).toFixed(2) + 'Mib'
  }
  return result
}

class Blob {
  session = ''
  index = 0
  size = 0
  received = 0
  storage = []

  constructor(session, size) {
    this.session = session
    this.size = size

    this.bar = new progress.SingleBar(BAR_OPTS)
    this.bar.start(size, 0)
  }

  feed(index, data) {
    if (index != this.index + 1)
      throw new Error(`invalid index ${index}, expected ${blob.index + 1}`)

    this.received += data.length
    this.storage.push(data)
    this.index++
    this.bar.update(this.received, toBarPayload(this))
  }

  done() {
    this.bar.stop()
    return Buffer.concat(this.storage)
  }
}

class File {
  session = ''
  index = 0
  size = 0
  received = 0
  name = ''
  fd = null

  constructor(session, size, fd) {
    this.session = session
    this.size = size
    this.fd = fd
    this.bar = new progress.SingleBar(BAR_OPTS)
    this.bar.start(size, 0)
  }

  progress(length) {
    this.received += length
    this.bar.update(this.received, toBarPayload(this))
  }

  done() {
    this.bar.stop()
    this.fd.close()
  }
}

class Handler {
  /**
   * @param {string} cwd working directory
   * @param {string} root bundle root
   */
  constructor(cwd, root) {
    this.script = null
    this.blobs = new Map()
    this.files = new Map()
    this.root = root
    this.cwd = cwd
    this.session = null
  }

  /**
   * get Blob by uuid
   * @param {string} id uuid
   */
  blob(id) {
    const blob = this.blobs.get(id)
    if (!blob) {
      // console.log('id', id, this.blobs)
      throw new Error('invalid session id')
    }
    return blob
  }

  /**
   * get file object by uuid
   * @param {string} id uuid
   */
  file(id) {
    const fd = this.files.get(id)
    if (!fd) {
      throw new Error('invalid file id')
    }
    return fd
  }

  async memcpy({ event, session, size, index }, data) {
    if (event === 'begin') {
      console.log(chalk.green('fetching decrypted data'))

      const blob = new Blob(session, size)
      this.blobs.set(session, blob)
      this.ack()
    } else if (event === 'data') {
      const blob = this.blob(session)
      blob.feed(index, data)
      this.ack()
    } else if (event === 'end') {

    } else {
      throw new Error('NOTREACHED')
    }
  }

  /**
   * secure path concatenation
   * @param {string} filename relative path component
   */
  async output(filename) {
    const abs = path.resolve(this.cwd, path.relative(this.root, filename))
    const rel = path.relative(this.cwd, abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      await mkdirp(path.dirname(abs))
      return abs
    }
    throw Error(`Suspicious path detected: ${filename}`)
  }

  async patch({ offset, blob, size, filename }) {
    const output = await this.output(filename)
    const fd = await fs.open(output, 'a')
    let buf = null
    if (blob) {
      buf = this.blob(blob).done()
      this.blobs.delete(blob)
    } else if (size) {
      buf = Buffer.alloc(size)
      buf.fill(0)
    } else {
      throw new Error('NOTREACHED')
    }

    await fd.write(buf, 0, buf.length, offset)
    await fd.close()
  }

  ack() {
    this.script.post({ type: 'ack' })
  }

  async download({ event, session, stat, filename }, data) {
    if (event === 'begin') {
      console.log(chalk.bold('download'), chalk.greenBright(path.basename(filename)))
      const output = await this.output(filename)

      const fd = await fs.open(output, 'w', stat.mode)
      const file = new File(session, stat.size, fd)
      this.files.set(session, file)
      await fs.utimes(output, stat.atimeMs, stat.mtimeMs)
      this.ack()
    } else if (event === 'data') {
      const file = this.file(session)
      file.progress(data.length)
      await file.fd.write(data)
      this.ack()
    } else if (event === 'end') {
      const file = this.file(session)
      file.done()
      this.files.delete(session)
    } else {
      throw new Error('NOTREACHED')
    }
  }

  connect(script) {
    this.script = script
    script.message.connect(this.dispatcher.bind(this))
  }

  dispatcher({ type, payload }, data) {
    if (type === 'send') {
      const { subject } = payload;
      if (typeof this[subject] === 'function') {
        // don't wait
        // console.log(subject)
        this[subject].call(this, payload, data)
      }
    } else if (type === 'error') {
      session.detach()
    } else {
      console.log('UNKNOWN', type, payload, data)
    }
  }
}

function detached(reason, crash) {
  if (reason === 'application-requested')
    return

  console.error(chalk.red('FATAL ERROR: session detached'))
  console.error('reason:', chalk.yellow(reason))
  if (reason === 'server-terminated')
    return

  if (!crash)
    return

  for (let [key, val] of Object.entries(crash))
    console.log(`${key}:`, typeof val === 'string' ? chalk.redBright(val) : val)
}

async function dump(dev, session, opt) {
  const output = opt.output || 'dump'
  await mkdirp(output)

  const parent = path.join(output, opt.app, 'Payload')

  try {
    const stat = await fs.stat(parent)
    if (stat.isDirectory() && !opt.override)
      throw new Error(`Destination ${parent} already exists. Try --override`)
  } catch (ex) {
    if (ex.code !== 'ENOENT')
      throw ex
  }

  session.detached.connect(detached)

  const read = (...args) => fs.readFile(path.join(__dirname, ...args)).then(buf => buf.toString())
  const js = await read('dist', 'agent.js')
  const c = await read('cmod', 'source.c')

  const script = await session.createScript(js)
  await script.load()
  const root = await script.exports.base()
  const cwd = path.join(parent, path.basename(root))
  await mkdirp(cwd)

  console.log('app root:', chalk.green(root))

  const handler = new Handler(cwd, root)
  handler.connect(script)

  console.log('dump main app')

  await script.exports.prepare(c)
  await script.exports.dump()

  console.log('patch PluginKit validation')
  const pkdSession = await dev.attach('pkd')
  const pkdScript = await pkdSession.createScript(js)
  await pkdScript.load()
  await pkdScript.exports.skipPkdValidationFor(session.pid)
  pkdSession.detached.connect(detached)

  try {
    console.log('dump extensions')
    const pids = await script.exports.launchAll()
    for (let pid of pids) {
      if (await pkdScript.exports.jetsam(pid) !== 0) {
        throw new Error(`unable to unchain ${pid}`)
      }

      const pluginSession = await dev.attach(pid)
      const pluginScript = await pluginSession.createScript(js)
      pluginSession.detached.connect(detached)

      await pluginScript.load()
      await pluginScript.exports.prepare(c)
      const childHandler = new Handler(cwd, root)
      childHandler.connect(pluginScript)

      await pluginScript.exports.dump()
      await pluginScript.unload()
      await pluginSession.detach()
      await dev.kill(pid)
    }
  } catch (ex) {
    console.warn(chalk.redBright(`unable to dump plugins ${ex}`))
    console.warn(ex)
  }

  await script.unload()
  await session.detach()

  await pkdScript.unload()
  await pkdSession.detach()

  console.log('Congrats!')
  console.log('open', chalk.greenBright(parent))
}


const Device = require('./lib/device')


async function main() {
  const program = require('commander')

  program
    .name('bagbak')
    .option('-l, --list', 'list apps')
    .option('-h, --host <host>', 'hostname')
    .option('-u, --uuid <uuid>', 'uuid of USB device')
    .option('-o, --output <output>', 'output directory')
    .option('-f, --override', 'override existing')
    .usage('[bundle id or name]')

  program.parse(process.argv)

  if (program.uuid && program.host)
    throw new Error('Use either uuid or host')

  if (program.args.length > 1)
    throw new Error('For stability, only decrypt one app once')

  if (program.list && program.args.length)
    throw new Error('Invalid command')

  let device = null
  if (program.uuid)
    device = await Device.find(program.uuid)
  else if (program.host)
    device = await Device.connect(program.host)
  else
    device = await Device.usb()

  if (program.list) {
    const list = await device.dev.enumerateApplications()
    for (let app of list) {
      delete app.smallIcon
      delete app.largeIcon
    }
    console.table(list)
    return
  }

  if (program.args.length === 1) {
    const app = program.args[0]
    const opt = Object.assign({ app }, program)
    const session = await device.run(app)
    const { pid } = session
    await dump(device.dev, session, opt)

    await session.detach()
    // await device.dev.kill(pid)

    console.log(`
For now, this tool only fetch decrypted executable binaries without other resources.
To make a full reinstallable *.ipa, you need to manually fetch those files (e.g. via SSH).`)
    return
  }

  program.help()
}


main().catch(e => {
  console.error(chalk.red('FATAL ERROR'))
  console.error(e)
  process.exit()
})