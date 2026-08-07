import { describe, expect, it } from 'vitest'
import { answersLivePrompt } from '../../src/shared/local-answer'

const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const ETX = String.fromCharCode(3)
const OFFERED = [1, 2, 3]

describe('answersLivePrompt', () => {
  it('counts the digit of an offered option', () => {
    expect(answersLivePrompt('1', OFFERED)).toBe(true)
    expect(answersLivePrompt('3', OFFERED)).toBe(true)
  })

  it('counts Enter, which confirms the highlighted row', () => {
    expect(answersLivePrompt(CR, OFFERED)).toBe(true)
    expect(answersLivePrompt(LF, OFFERED)).toBe(true)
  })

  it('ignores a digit the agent did not offer', () => {
    // Typing "7" into a three-option panel is not an answer to it.
    expect(answersLivePrompt('7', OFFERED)).toBe(false)
    expect(answersLivePrompt('0', OFFERED)).toBe(false)
  })

  it('ignores arrow keys', () => {
    // Down arrow moves the selection; the panel is still waiting. Clearing
    // here would drop the request from the island permanently.
    expect(answersLivePrompt(`${ESC}[A`, OFFERED)).toBe(false)
    expect(answersLivePrompt(`${ESC}[B`, OFFERED)).toBe(false)
  })

  it('ignores a bare escape', () => {
    expect(answersLivePrompt(ESC, OFFERED)).toBe(false)
  })

  it('ignores Ctrl+C', () => {
    expect(answersLivePrompt(ETX, OFFERED)).toBe(false)
  })

  it('ignores ordinary letters', () => {
    expect(answersLivePrompt('hello', OFFERED)).toBe(false)
  })

  it('ignores empty input', () => {
    expect(answersLivePrompt('', OFFERED)).toBe(false)
  })

  it('answers nothing when the agent offered no options', () => {
    expect(answersLivePrompt('1', [])).toBe(false)
  })

  it('still counts Enter when no options were captured', () => {
    // A submit is a submit even for a panel whose list we failed to parse.
    expect(answersLivePrompt(CR, [])).toBe(true)
  })

  it('finds an answer inside a longer chunk', () => {
    // Terminals coalesce input; a paste or a fast keypress can arrive batched.
    expect(answersLivePrompt(`${ESC}[B2`, OFFERED)).toBe(true)
  })

  it('does not mistake an arrow-key sequence for its bracket digits', () => {
    // ESC [ 1 ; 5 A is Ctrl+Up. The "1" here is part of the sequence, but it
    // is also a real option digit — this documents that the check is
    // character-based and will treat it as an answer.
    expect(answersLivePrompt(`${ESC}[1;5A`, OFFERED)).toBe(true)
  })
})
