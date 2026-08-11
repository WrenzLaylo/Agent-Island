/**
 * A scripted stand-in for a real agent, for driving the wrapper end to end.
 *
 * It does the only two things the wrapper actually cares about: it prints
 * panel text, and it receives keystrokes. Every byte arriving on stdin is
 * appended to a record file as it lands, so a test can assert on exactly what
 * the wrapper sent and when — which is the half of the contract that unit
 * tests over pure functions can never reach.
 *
 * Plain .mjs rather than TypeScript: this runs as a child process under a
 * ConPTY, launched from a .cmd shim, so keeping it build-free removes a whole
 * class of "the test ran against a stale compile" failures.
 *
 * Driven entirely by env, because the wrapper owns the argv it passes down:
 *   FAKE_AGENT_SCENARIO  path to the scenario JSON
 *   FAKE_AGENT_RECORD    path to append stdin records to (JSON lines)
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const scenarioPath = process.env.FAKE_AGENT_SCENARIO
const recordPath = process.env.FAKE_AGENT_RECORD

if (!scenarioPath || !recordPath) {
  console.error('fake-agent: FAKE_AGENT_SCENARIO and FAKE_AGENT_RECORD are required')
  process.exit(2)
}

/**
 * @typedef {{ type: 'emit', text?: string, fixture?: string, raw?: boolean }
 *   | { type: 'sleep', ms: number }
 *   | { type: 'waitForInput', timeoutMs?: number, count?: number }} Step
 */

/** @type {{ steps: Step[], tailMs?: number }} */
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))

/** Every stdin chunk, in arrival order. Also mirrored to disk immediately. */
const received = []

writeFileSync(recordPath, '')

/*
 * Raw mode, because every agent this stands in for is a TUI that reads single
 * keypresses. Cooked mode leaves the console line discipline holding a bare
 * digit until an Enter that the wrapper deliberately never sends — the agent
 * would then look unresponsive for reasons that have nothing to do with the
 * code under test.
 */
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}

process.stdin.on('data', (chunk) => {
  const entry = { at: Date.now(), bytes: Array.from(chunk) }
  received.push(entry)
  // Appended per chunk, not at exit: a test that waits for a keystroke has to
  // be able to see it while this process is still running.
  appendFileSync(recordPath, JSON.stringify(entry) + '\n')
})
process.stdin.resume()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Terminals end lines with CRLF. Emitting bare LF leaves the cursor in the
 * middle of the line under ConPTY, which produces output no real agent would
 * ever generate and defeats the point of testing against the real scanner.
 */
function toTerminalNewlines(text) {
  return text.replace(/\r?\n/g, '\r\n')
}

async function waitForInput(count, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (received.length < count && Date.now() < deadline) {
    await sleep(20)
  }
  return received.length >= count
}

async function run() {
  for (const step of scenario.steps) {
    if (step.type === 'emit') {
      const body = step.fixture ? readFileSync(step.fixture, 'utf8') : (step.text ?? '')
      process.stdout.write(step.raw ? body : toTerminalNewlines(body))
    } else if (step.type === 'sleep') {
      await sleep(step.ms)
    } else if (step.type === 'waitForInput') {
      await waitForInput(step.count ?? 1, step.timeoutMs ?? 8000)
    }
  }
  // A tail window so the wrapper can flush its final scan and the test can
  // read the record before this process disappears.
  await sleep(scenario.tailMs ?? 250)
  process.exit(0)
}

run().catch((error) => {
  console.error('fake-agent: ' + (error?.stack ?? error))
  process.exit(1)
})
