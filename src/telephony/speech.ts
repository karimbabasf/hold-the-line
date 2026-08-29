/**
 * Turns harness text into something a phone voice can read out loud.
 *
 * Everything here exists because of one live turn on 2026-08-29. Reassembled
 * from the wire it read:
 *
 *   "I can look into that for you. Give me just a second.Checking on that
 *    now.Bear with me.I've got your file here. ... $13,481.12."
 *
 * Three separate faults in one line of speech:
 *
 *   1. Each tool round is its own `model.message`, and the deltas of two
 *      messages were concatenated with nothing between them. A period with no
 *      following space is read as a stumble, which is the "sentences and then
 *      dot" an operator hears.
 *   2. The agent said a filler before every tool call, so three consecutive
 *      tool calls produced three fillers back to back and no information.
 *   3. `$13,481.12` reached Telnyx TTS as written and the decimal point came
 *      out as the word "dot".
 *
 * The shaper is a stream, not a string function, because the harness splits
 * tokens anywhere: "$13,481.12" arrives as "$13" "," "481" "." "12". Anything
 * that looks at one delta at a time cannot see a number at all.
 *
 * One rule constrains all of it. `offer.state_settlement` returns the wording
 * an operator approved and the agent says it back word for word, so nothing
 * here may reword. Digits are copied through untouched and only the symbols
 * around them are replaced, which is why $13,481.12 becomes "13,481 dollars
 * and 12 cents" rather than being spelled out: the amount spoken is provably
 * the amount approved.
 */

/**
 * The fillers agent.json tells the agent to use, word for word.
 *
 * A closed set on both sides is the point. The instructions name these five
 * and nothing else, so matching them literally cannot silence a sentence that
 * carried information, which a looser "sounds like a filler" rule could.
 */
export const SPOKEN_FILLERS: readonly string[] = [
  'let me pull that up',
  'one moment while i check',
  'give me just a second',
  'bear with me',
  'checking on that now',
];

/** Lowercase, letters and digits and spaces only, so punctuation cannot miss. */
function forMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the whole line is one of the five fillers and nothing else. */
export function isFillerLine(text: string): boolean {
  return SPOKEN_FILLERS.includes(forMatch(text));
}

/** True while the text could still grow into a filler. */
function couldBecomeFiller(text: string): boolean {
  const soFar = forMatch(text);
  return SPOKEN_FILLERS.some((f) => f.startsWith(soFar));
}

/**
 * A dollar amount: grouped or plain digits, optional cents.
 *
 * The grouped alternative is first so "$13,481" matches whole rather than
 * stopping at "$13".
 */
const CURRENCY = /\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

/**
 * Rewrites figures into the words a TTS engine reads correctly.
 *
 * Currency first, so that by the time the bare-decimal rule runs there is no
 * money left for it to turn into "point". The digits are never rebuilt, only
 * copied, so the figure cannot drift from the one on the record.
 */
export function speakNumbers(text: string): string {
  return text
    .replace(CURRENCY, (_match, whole: string, cents: string | undefined) => {
      const unit = whole.replace(/,/g, '') === '1' ? 'dollar' : 'dollars';
      if (cents === undefined) return `${whole} ${unit}`;
      // "12" is twelve cents, ".5" is fifty. Padding right rather than parsing
      // the fraction keeps that the same either way.
      const count = Number(cents.padEnd(2, '0'));
      if (count === 0) return `${whole} ${unit}`;
      return `${whole} ${unit} and ${count} ${count === 1 ? 'cent' : 'cents'}`;
    })
    .replace(/(\d)\.(\d)/g, '$1 point $2');
}

/**
 * Puts back the space in "check.Checking".
 *
 * The message-boundary fix below is what stops this happening in the first
 * place, so this only fires if a future harness release stops emitting one
 * `model.message` per message, or if the model itself glues two sentences.
 * A capital after the period is required and a capital before it disqualifies
 * the match, so "U.S." is left alone.
 */
function unglue(text: string): string {
  return text.replace(/([a-z0-9])([.!?])([A-Z])/g, '$1$2 $3');
}

/**
 * How many characters at the end of `text` are not safe to speak yet.
 *
 * Two cases. A trailing run of number characters may be half of a figure that
 * the next delta completes. A trailing sentence terminator may be the left
 * half of a glued boundary that `unglue` can only see with the next character
 * beside it. Both are released by the next push or by the end of the message,
 * so the hold is a delta long, not a pause a caller would notice.
 *
 * `text` carries one already-spoken character on the front as context. The
 * harness really does send " down" then "." then "Your" as three deltas, and
 * without that character the period looks like the start of a chunk rather
 * than the end of a word, so it went out alone and the glue survived.
 */
function heldBack(text: string): number {
  let i = text.length;
  while (i > 0 && /[0-9,.$]/.test(text[i - 1] as string)) i--;
  const run = text.slice(i);
  if (run && /[0-9$]/.test(run)) return run.length;
  if (/[a-z0-9][.!?]$/i.test(text)) return 1;
  return 0;
}

export interface SpeechShaper {
  /** Opens a harness message and returns whatever the last one still held. */
  startMessage(): string;
  /** Feeds one delta and returns the text that is safe to speak now. */
  push(text: string): string;
  /** Ends the turn and returns everything still held. */
  end(): string;
}

/**
 * One shaper per turn. The filler rule is per turn by construction: a new
 * turn builds a new shaper, so the caller hears a filler again on their next
 * question.
 */
export function createSpeechShaper(): SpeechShaper {
  /** Text that has passed the filler gate but may still be half a number. */
  let pending = '';
  /** Last character actually spoken, so a boundary knows if it needs a space. */
  let lastSpoken = '';
  /** A message has opened and nothing of it has been spoken yet. */
  let atBoundary = false;
  /** A filler has already gone out on this turn. */
  let fillerSpoken = false;

  /** The sentence being received, from its first character. */
  let sentence = '';
  /** That sentence's text, while it might still turn out to be a filler. */
  let holding = '';
  /** The sentence has been judged not a filler and is streaming. */
  let released = true;
  /** Last raw character received, so a boundary that falls between two deltas
   *  is still seen. "now." and " One" arrive separately. */
  let lastReceived = '';

  /**
   * Adds text to the buffer and returns what is safe to speak.
   *
   * The last character already spoken rides along as context so that both the
   * hold decision and the repair can see across a delta boundary, then it is
   * cut back off. It is never a digit or a `$`, because a run containing
   * either is always held, so it cannot take part in a rewrite and slicing it
   * off is exact.
   */
  function emit(text: string, drain = false): string {
    pending += text;
    const context = atBoundary ? '' : lastSpoken;
    const hold = drain ? 0 : heldBack(context + pending);
    const ready = pending.slice(0, pending.length - hold);
    pending = pending.slice(pending.length - hold);
    if (!ready) return '';

    let out = unglue(speakNumbers(context + ready)).slice(context.length);
    if (atBoundary) {
      if (lastSpoken && !/\s$/.test(lastSpoken) && !/^\s/.test(out)) out = ` ${out}`;
      atBoundary = false;
    }
    lastSpoken = out.slice(-1);
    return out;
  }

  /**
   * Takes a run of text that belongs to the sentence now open.
   *
   * The gate closes only once a filler has already gone out on this turn, so
   * the first thing a caller hears is never delayed. After that it holds a
   * sentence for exactly as long as the words so far are still the opening of
   * one of the five fillers, which is normally a single word.
   */
  function feed(text: string): string {
    if (!text) return '';
    sentence += text;

    if (!released) {
      holding += text;
      // A figure settles it: a filler never carries one and a binding sentence
      // always does, so nothing with digits in it is ever dropped.
      if (!/\d/.test(sentence) && couldBecomeFiller(sentence)) return '';
      released = true;
      const out = emit(holding);
      holding = '';
      return out;
    }

    if (fillerSpoken && !/\d/.test(sentence) && couldBecomeFiller(sentence)) {
      released = false;
      holding = sentence;
      return '';
    }
    return emit(text);
  }

  /** Closes the open sentence: drops a repeated filler, speaks anything else. */
  function endSentence(): string {
    let out = '';
    if (!released) {
      // It stopped growing while still matching. Either it is exactly a
      // filler, and one has already been spoken, so it is dropped; or it was
      // cut short mid-phrase and is said.
      if (!isFillerLine(sentence)) out += emit(holding);
      holding = '';
      released = true;
    }
    if (isFillerLine(sentence)) fillerSpoken = true;
    sentence = '';
    return out;
  }

  /** Ends the open message: closes its last sentence, then drains the buffer. */
  function closeMessage(): string {
    const out = endSentence() + emit('', true);
    lastReceived = '';
    return out;
  }

  return {
    startMessage(): string {
      const out = closeMessage();
      atBoundary = true;
      return out;
    },

    push(text: string): string {
      if (!text) return '';
      let out = '';
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const previous = i === 0 ? lastReceived : (text[i - 1] as string);
        // Whitespace after a terminator ends a sentence. The whitespace goes
        // with the sentence that follows, so dropping that sentence takes its
        // leading space with it and never leaves a double gap.
        if (/\s/.test(text[i] as string) && /[.!?]/.test(previous)) {
          out += feed(text.slice(start, i));
          out += endSentence();
          start = i;
        }
      }
      out += feed(text.slice(start));
      lastReceived = text.slice(-1);
      return out;
    },

    end(): string {
      const out = closeMessage();
      atBoundary = false;
      return out;
    },
  };
}
