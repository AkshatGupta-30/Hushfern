import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const REVISION = '99fcd17675864b43d0b13a302345e9c7fcefbb77'
const MODEL_ID = 'Xenova/toxic-bert'
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..')
const MODEL_DIRECTORY = path.join(PROJECT_DIRECTORY, 'public', 'models', ...MODEL_ID.split('/'))
const REMOTE_ROOT = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}`

const FILES = [
  {
    path: 'config.json',
    sha256: 'e2c6937717530ce48ea753182c5558c8b285a0e1dd7824759d63a81adce28447',
  },
  {
    path: 'special_tokens_map.json',
    sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
  },
  {
    path: 'tokenizer.json',
    sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  },
  {
    path: 'tokenizer_config.json',
    sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  },
  {
    path: 'vocab.txt',
    sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  },
  {
    path: 'onnx/model.onnx',
    sha256: 'a092927576be0a4884f791415fd375a702c09f1f10411295c56728404a5ff3e2',
  },
]

async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function isVerified(filePath, expectedHash) {
  try {
    const fileStats = await stat(filePath)
    return fileStats.isFile() && (await hashFile(filePath)) === expectedHash
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function downloadFile(file) {
  const destination = path.join(MODEL_DIRECTORY, ...file.path.split('/'))
  if (await isVerified(destination, file.sha256)) {
    console.log(`[model] verified ${file.path}`)
    return
  }

  await mkdir(path.dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.download`
  await removeIfPresent(temporaryPath)

  const response = await fetch(`${REMOTE_ROOT}/${file.path}?download=true`, {
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${file.path}: HTTP ${response.status}`)
  }

  console.log(`[model] downloading ${file.path}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath))
  const actualHash = await hashFile(temporaryPath)
  if (actualHash !== file.sha256) {
    await removeIfPresent(temporaryPath)
    throw new Error(
      `SHA-256 mismatch for ${file.path}: expected ${file.sha256}, received ${actualHash}`,
    )
  }

  await removeIfPresent(destination)
  await rename(temporaryPath, destination)
  console.log(`[model] installed ${file.path}`)
}

await mkdir(MODEL_DIRECTORY, { recursive: true })
for (const file of FILES) await downloadFile(file)
console.log(`[model] ${MODEL_ID}@${REVISION} is ready for packaging`)
