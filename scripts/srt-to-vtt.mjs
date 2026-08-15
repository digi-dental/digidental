#!/usr/bin/env node
/**
 * SRT → WebVTT, for the two marketing clips.
 *
 * Machine transcription hands back two to four words per cue. That is fine as a data format and
 * unreadable as captions: at ~40 cues a minute the text flickers faster than anyone can follow.
 * This merges cues into lines that stay on screen long enough to read, breaks on sentence ends,
 * wraps to at most two lines, and strips the transcription service's watermark from cue one.
 *
 * Usage:
 *   node scripts/srt-to-vtt.mjs in.srt captions/out.en.vtt "Note shown in the file header"
 *
 * Re-run it if either clip is re-cut. Captions must match the audio — never hand-edit the VTT
 * to say something the voiceover does not.
 */
import fs from 'node:fs';

const MAX_CHARS = 76;   // longest merged cue, before wrapping
const MAX_DUR = 6.0;    // seconds; a cue on screen longer than this has drifted from the audio
const WRAP_AT = 42;     // wrap to a second line past this, at a word boundary

const secs = t => {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
};

function parseSrt(text) {
  return text.trim().split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n').filter(l => l.trim());
    const timing = lines.find(l => l.includes('-->'));
    if (!timing) return [];
    const body = lines.slice(lines.indexOf(timing) + 1).join(' ')
      .replace(/\(Transcribed by TurboScribe\.[^)]*\)\s*/g, '')
      .trim();
    if (!body) return [];
    const [start, end] = timing.split('-->').map(t => t.trim().replace(',', '.'));
    return [{ start, end, text: body }];
  });
}

function merge(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    const endsSentence = prev && /[.?!]$/.test(prev.text);
    if (prev && !endsSentence
        && prev.text.length + 1 + cue.text.length <= MAX_CHARS
        && secs(cue.end) - secs(prev.start) <= MAX_DUR) {
      prev.end = cue.end;
      prev.text += ' ' + cue.text;
    } else {
      out.push({ ...cue });
    }
  }
  return out;
}

// Break nearest the middle rather than at the first opportunity, so the two lines are close to
// even — the convention captions use so the eye does not have to travel.
function wrap(text) {
  if (text.length <= WRAP_AT) return text;
  const mid = Math.floor(text.length / 2);
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best === -1 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best === -1 ? text : text.slice(0, best) + '\n' + text.slice(best + 1);
}

const [src, dst, note] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node scripts/srt-to-vtt.mjs <in.srt> <out.vtt> [note]');
  process.exit(1);
}

const cues = merge(parseSrt(fs.readFileSync(src, 'utf8')));
const body = cues
  .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${wrap(c.text)}\n`)
  .join('\n');
fs.writeFileSync(dst, `WEBVTT\nNOTE ${note || dst}\n\n${body}`);

console.log(`${dst}: ${cues.length} cues from ${parseSrt(fs.readFileSync(src, 'utf8')).length} source cues`);
