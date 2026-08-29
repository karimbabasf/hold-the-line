# Northvane Mutual: hold-the-line scenario, final build spec

Self-contained. Assumes no prior context.

## The premise in one paragraph

Northvane Mutual is a fictional auto insurer. A policyholder calls the claims line about a car
the body shop says is a write-off. A voice agent running on TrueForge answers, pulls the real
records, computes the settlement in a sandbox, and then puts the caller on hold while a human
operator approves the exact sentence that commits the company to a dollar figure. The operator
can edit that sentence, or reject it and send the agent back to recompute. The agent then speaks
the approved words verbatim.

**The core idea, and the line the project is built around: the gate sits on the utterance, not on
the tool call.** The agent is forbidden from speaking a binding sentence directly. To say one it
must call a gated tool whose argument IS the sentence. TrueForge holds the call with
`require_approval_for_tools`, emits `tool.approval_required`, and the TTS layer only ever renders
the approved string that the tool returns. There is no code path from the model's own text
generation to the speaker for a binding utterance.

---

## 1. MVP: what ships

### MUST BUILD, in this order

**1. Telephony round trip.** Inbound call, speech to text in, text to speech out. Hard checkpoint
at 12:00. If it is not working by then, switch to a browser softphone and describe it honestly as
a call in the video. Do not burn the last hour on carrier config. This is the single biggest scope
risk in the whole build and it is not the lanes.

**2. Five JSON fixtures.** Flat files on disk, listed in section 5 below. No database, no ORM,
no migration. Ten minutes of work.

**3. Fan-out as a config loop.** Five real concurrent tool calls with staggered fixture latency,
plus an on-screen serial versus parallel counter. Write it as a loop over an array of lane
definitions, never as five hand-written call sites. Done that way, five lanes cost exactly what
three cost, which is why lanes are the wrong thing to cut for time.

**4. One parameterised sandbox script.** A single `settle(claim, retain_salvage: bool)` function
that does the total-loss threshold check and the full settlement in one pass. It gets called
twice: once for the cash offer, once for the operator's requested salvage alternative. Three
scripts collapsed into one script called twice, same thing on camera, a third of the work.

**5. The gate, with the re-fire.** Draft sentence on the operator console, the computed breakdown
and the source records beside it, operator edits the text, operator clicks "recompute with salvage
retention", the sandbox reruns, the gate fires a second time, operator approves, agent speaks the
approved string. This is the centrepiece and gets more build time than anything else on the list.

**6. Session suspend and resume, keyed on caller phone number.** On disconnect, persist a dict to
a JSON file: `{computed_results, pending_draft, transcript_index, gate_state}`. On an inbound call
from the same number within ten minutes, load it and open with a resume line instead of a greeting.
Roughly twenty minutes of work because it is a dictionary written to disk, not a state machine.
Three details make it read as real rather than as a reset:
   - The agent resumes **mid-thought**, naming the exact question that was open when the line
     dropped, not the start of the call.
   - **Nothing is recomputed.** The console shows the same run IDs on the resumed numbers as
     before the drop. That is the proof that state survived rather than being regenerated.
   - The pending gate draft survives too. If the line drops while the operator is mid-edit, the
     draft is still there when the caller rings back.

**7. Operator console.** One HTML page, server-sent events, no framework, three panes:
   - **Lanes.** Five rows, each showing tool name, elapsed ms, and result summary. Serial versus
     parallel counter underneath.
   - **Computed.** Every number the agent is holding, each tagged either `computed` with a
     sandbox run ID, or `record` with the fixture and field it came from. Nothing untagged.
   - **Gate.** The draft utterance in a text box, the breakdown beside it, and three buttons:
     Approve, Approve with edits, Send back to recompute.

### DROP FIRST, in this order

1. **The second approval gate.** Do not make `settlement.accept` a separate round trip. Instead,
   the operator's single approval covers the offer sentence and **scopes a pre-authorisation to
   the two exact amounts inside it**. If the caller accepts either 13,481.12 or 9,180.12, the
   agent may record it. Any other amount re-fires the gate. This saves fifteen seconds of runtime
   and a whole approval cycle, and the scoped pre-authorisation is a better design than a second
   click, not a worse one.
2. **Five separate MCP servers.** One server exposing all the read tools is still genuine tool
   reach. Nobody in the room is counting servers.
3. **Barge-in and interruption handling.** The scripted caller interrupts exactly once, and that
   interruption can land on a sentence boundary.
4. **Voice quality.** Robotic text to speech is acceptable. Zero minutes on voice tuning.
5. **The live audit-trail screen.** If time is short, make it a static screenshot in the edit.
6. **Lanes 4 and 5** (claims history, yard storage), and only if the fan-out somehow ended up
   hand-written instead of config-driven. If it is a loop, keep all five.

**Build ends 13:45, not 14:00.** A 2:15 call needs three takes and time to pick one.

---

## 2. The hostile judge: "you should not automate this at all"

**Yes, this scenario invites that reaction.** Insurance settlement is a regulated job done by
licensed adjusters, and a judge looking for a reason to mark down "control and safety" will reach
for exactly this. The objection has to be answered inside the demo, before it is formed, not in
the Q and A afterwards.

Three things in the design answer it. All three only work if they are said out loud.

**A. The agent is not the adjuster. The operator is the adjuster.**
The agent is the adjuster's hands and calculator. One adjuster holds four calls instead of one,
and the caller gets a real number in three minutes instead of a six-day callback. The pitch is
about the caller not waiting, never about removing headcount. Say this at 0:05, in one line, before
the judge has time to form the objection on their own.

**B. The split of labour is visible, and it is the correct split.**
The machine does what humans are bad at: six lookups at once, per-diem date arithmetic, mileage
adjustment across comparable listings. The human does what machines are bad at: committing the
company to a number, and noticing the option the caller actually wants. The salvage-retention
catch is that entire argument compressed into one gesture, which is why it earns forty-eight
seconds of a two-minute call.

**C. The agent never exercises judgement.** It quotes records and it computes. It does not deny
coverage, interpret policy language, or decide liability. Those tools exist in the design and every
one of them is gated. Say that in a sentence.

**The counters are what actually convert an engineering audience.** Put two live counters on the
console and hold them on screen at the end:

```
numbers spoken 14   |   computed 8   |   traced to record 6   |   recalled 0
binding utterances 2   |   approved 2   |   spoken unapproved 0
```

The invariant is not "everything is computed", which would be a lie, since a deductible is a
lookup. The honest invariant is stronger and easier to defend: **every number is either computed
in the sandbox or traced to a source record, and none is recalled from the model.** An engineer
respects an invariant with a live count behind it far more than any amount of talking about safety.

**Expect a second angle: "the operator cannot verify 21,340 in two seconds, so the gate is a
compliance fig leaf."** The answer is on screen already. The breakdown and the source records sit
next to the sentence, and the re-fire proves the operator can push back and change the outcome.
This also maps onto what an adjuster already does today after reading a valuation report, so it is
a real workflow rather than an invented one.

**Expect a third, quieter one: an infrastructure room may find insurance boring.** The tow-yard
meter and a caller who sounds genuinely stressed do that work. Do not read the caller lines flat.

---

## 3. The call script, retimed to 2:15

Compressions applied: one sandbox script called twice, five lanes kept, second gate folded into a
scoped pre-authorisation.

| Time | Beat |
|---|---|
| **0:00** | Caller, standing at a tow yard, traffic behind him: "Claim 40218, the Outback. Shop says it's totaled and the yard is charging me by the day. What am I getting?" |
| **0:05** | Agent: "I have the claim, and I have an adjuster on this call with me. Give me a moment, I am pulling everything at once." One line, and the "you should not automate this" objection is answered before it forms. |
| **0:08** | **FAN-OUT.** Five lanes fire concurrently, returning at 1.1s, 1.6s, 2.2s, 2.8s, 3.4s: policy and deductible, three valuation comps, lienholder payoff, prior damage and claim history, state rules. Console counter: **3.4s parallel versus 11.1s serial.** |
| **0:14** | Agent fills the dead air with the first lane that landed: "While that finishes, your rental has four days left and the yard is at 75 a day." Both are real numbers off real lanes, which is the point. |
| **0:20** | **SANDBOX CALL 1**, `settle(claim, retain_salvage=false)`. The script is written live on the console: adjust three comps to 52,400 miles, average, subtract prior damage, add options, check against the state threshold, then build the settlement. |
| **0:32** | Agent: "Your car was worth 21,340 dollars. Repairs came to 16,780, which is 78.6 percent of that, and our threshold in this state is 75. So yes, it is a total loss." |
| **0:38** | Agent walks the number: "After tax and fees, less your thousand-dollar deductible, less the payoff to Cascade, you are at 13,481 dollars and 12 cents." |
| **0:45** | **THE PROOF BEAT.** Caller cuts in: "Hold on. My statement said 8,700. Where's 8,764 coming from?" Agent: "Your loan accrues 1 dollar 84 cents a day. I quoted the payoff through October 2, which is 35 days of interest." Recall cannot produce that number. Only the run can. |
| **0:57** | **THE DROP.** Caller: "Okay, so what do I..." Line dies. Console shows `SESSION 7c21 SUSPENDED`, holding the computed figures, the pending gate draft, and the transcript index. |
| **1:03** | Same number rings back. Agent: "Welcome back. You were asking about the payoff. Nothing was recomputed, your net is still 13,481 dollars and 12 cents." Console shows identical run IDs on the resumed numbers. The storage meter has kept ticking in the corner the whole time. |
| **1:10** | **THE GATE.** Agent goes quiet and calls `offer.state_settlement`. Console lights up: `HIGH / BINDING SETTLEMENT OFFER / IRREVERSIBLE`, breakdown and source records beside the draft: *"Northvane can settle your claim today at 13,481 dollars and 12 cents, final, and that closes claim 40218."* |
| **1:22** | Operator does not rubber-stamp. Strikes the word **final** (it is an offer, not a take-it-or-leave-it), then clicks **Send back to recompute: salvage retention**, because the caller mentioned wanting the car. |
| **1:30** | **SANDBOX CALL 2**, `settle(claim, retain_salvage=true)`. Two seconds. 13,481.12 minus the 4,301.00 salvage bid equals 9,180.12. Gate fires a second time with the amended draft. |
| **1:38** | Operator approves: *"Northvane can settle at 13,481 dollars and 12 cents. That offer stands for 30 days and you may use your own appraiser. If you would rather keep the car, we can settle at 9,180 dollars and 12 cents with a salvage title, subject to your lender releasing it."* Agent speaks it verbatim. Console shows the diff: wanted versus said. |
| **1:52** | Caller takes the cash. Amount matches a pre-authorised figure, so no second gate. Agent: "Recorded. Payment goes out today. Storage has run six days, 450 dollars, and I have released the vehicle so it stops tonight." |
| **2:10** | Counters hold on screen: numbers spoken 14, computed 8, traced to record 6, recalled 0. Binding utterances 2, approved 2, spoken unapproved 0. |
| **2:15** | End of call. Leaves roughly 40 seconds for the repo, the review trail, and the closing line on what the harness gave versus what was written by hand. |

---

## 4. Reconciliation table for every spoken number

Arithmetic checked. A judge who pauses the video finds this sums.

### 4.1 Comparable adjustment to subject mileage (52,400 mi, rate 0.085 per mile)

| Comp | List price | Comp mileage | Adjustment `(comp_mi - 52,400) x 0.085` | Adjusted |
|---|---|---|---|---|
| C-1 | 22,495.00 | 41,200 | (41,200 - 52,400) x 0.085 = -952.00 | **21,543.00** |
| C-2 | 21,150.00 | 58,900 | (58,900 - 52,400) x 0.085 = +552.50 | **21,702.50** |
| C-3 | 20,980.00 | 55,100 | (55,100 - 52,400) x 0.085 = +229.50 | **21,209.50** |

Sum 21,543.00 + 21,702.50 + 21,209.50 = 64,455.00. Mean = 64,455.00 / 3 = **21,485.00**

### 4.2 Actual cash value

| Line | Value |
|---|---|
| Comp mean | 21,485.00 |
| Prior damage, right rear quarter panel repair | -640.00 |
| Options: roof rails 150.00 + tow package 220.00 + upgraded audio 125.00 | +495.00 |
| **ACV** | **21,340.00** |

Check: 21,485.00 - 640.00 = 20,845.00; 20,845.00 + 495.00 = **21,340.00**

### 4.3 Total loss threshold

16,780.00 / 21,340.00 = 0.78632 = **78.6 percent**. State threshold **75 percent**. 78.6 > 75, so
it is a total loss.

### 4.4 Settlement, cash option

| Line | Arithmetic | Value |
|---|---|---|
| ACV | | 21,340.00 |
| Sales tax reimbursement at 8.6 percent | 21,340.00 x 0.086 | +1,835.24 |
| Title fee | fixture | +15.00 |
| Registration fee | fixture | +55.00 |
| Subtotal | 21,340.00 + 1,835.24 + 15.00 + 55.00 | 23,245.24 |
| Collision deductible | fixture | -1,000.00 |
| After deductible | 23,245.24 - 1,000.00 | 22,245.24 |
| Lien payoff | see 4.5 | -8,764.12 |
| **Net to customer** | 22,245.24 - 8,764.12 | **13,481.12** |

Tax check: 21,340.00 x 0.08 = 1,707.20; 21,340.00 x 0.006 = 128.04; total **1,835.24**

### 4.5 Lien payoff, quoted through 2026-10-02

| Line | Arithmetic | Value |
|---|---|---|
| Principal as of quote date 2026-08-28 | fixture | 8,699.72 |
| Days 2026-08-28 to 2026-10-02 | 3 (to Aug 31) + 30 (Sep) + 2 (Oct) | 35 |
| Accrued interest | 1.84 x 35 | +64.40 |
| **Payoff** | 8,699.72 + 64.40 | **8,764.12** |

This is the number the caller challenges. Their last statement showed 8,699.72, which rounds to
"about 8,700" in the caller's mouth.

### 4.6 Salvage retention option

| Line | Arithmetic | Value |
|---|---|---|
| Cash settlement | from 4.4 | 13,481.12 |
| Salvage bid, owner keeps vehicle | fixture | -4,301.00 |
| **Net with salvage retention** | 13,481.12 - 4,301.00 | **9,180.12** |

### 4.7 Secondary spoken numbers

| Number | Source | Arithmetic |
|---|---|---|
| Rental days remaining: **4** | computed | 30 allowed - 26 used |
| Yard rate: **75.00 per day** | record | `claim.storage_per_day` |
| Storage accrued: **450.00** | computed | 6 days (2026-08-22 to 2026-08-28) x 75.00 |
| Deductible: **1,000.00** | record | `policy.deductible_collision` |
| Repair estimate: **16,780.00** | record | `claim.repair_estimate` |
| Per diem: **1.84** | record | `vehicle.lien.per_diem` |
| Threshold: **75 percent** | record | `state_rule.total_loss_threshold_pct` |
| Offer validity: **30 days** | record | `state_rule.offer_validity_days` |

**Tally for the on-screen counter: 14 numbers spoken, 8 computed in the sandbox, 6 traced to a
source record, 0 recalled.**

The 8 computed: the ACV 21,340.00, the ratio 78.6 percent, the tax 1,835.24, the payoff 8,764.12,
the 35 days, the net 13,481.12, the salvage net 9,180.12, and the 4 rental days. The 450.00 storage
figure is the ninth if a judge counts it separately. The invariant holds either way, which is why
the counter is generated from the run log rather than hard-coded.

---

## 5. The five fixture files

### `fixtures/policy.json`
```json
{
  "policy_id": "NVM-4417-2288",
  "holder_name": "Daniel Ortiz",
  "phone": "+14155550142",
  "state": "AZ",
  "coverages": ["collision", "comp", "rental"],
  "deductible_collision": 1000.00,
  "rental_days_allowed": 30,
  "rental_days_used": 26,
  "effective_from": "2026-03-01",
  "effective_to": "2027-03-01"
}
```

### `fixtures/claim.json`
```json
{
  "claim_id": "CLM-40218",
  "policy_id": "NVM-4417-2288",
  "vin": "4S4BTAFC7M3201884",
  "loss_date": "2026-08-21",
  "quote_date": "2026-08-28",
  "repair_estimate": 16780.00,
  "shop_name": "Bayview Collision",
  "yard_id": "YRD-118",
  "storage_per_day": 75.00,
  "storage_start": "2026-08-22",
  "status": "pending_total_loss_review",
  "adjuster": "operator on duty"
}
```

### `fixtures/vehicle.json`
```json
{
  "vin": "4S4BTAFC7M3201884",
  "year": 2021,
  "make": "Subaru",
  "model": "Outback",
  "trim": "Premium",
  "mileage": 52400,
  "condition_grade": "average",
  "options": [
    { "name": "roof rails", "value": 150.00 },
    { "name": "tow package", "value": 220.00 },
    { "name": "upgraded audio", "value": 125.00 }
  ],
  "prior_damage": [
    { "desc": "right rear quarter panel repair, 2024", "deduction": 640.00 }
  ],
  "lien": {
    "lender": "Cascade Auto Finance",
    "loan_id": "CAF-9920431",
    "principal": 8699.72,
    "principal_as_of": "2026-08-28",
    "per_diem": 1.84,
    "good_through": "2026-10-02"
  },
  "salvage_bid": 4301.00
}
```

### `fixtures/comps.json`
```json
[
  {
    "comp_id": "C-1",
    "vin_ref": "4S4BTAFC7M3201884",
    "year": 2021, "make": "Subaru", "model": "Outback", "trim": "Premium",
    "mileage": 41200,
    "list_price": 22495.00,
    "distance_mi": 12,
    "source": "regional listing feed",
    "listed_on": "2026-08-19"
  },
  {
    "comp_id": "C-2",
    "vin_ref": "4S4BTAFC7M3201884",
    "year": 2021, "make": "Subaru", "model": "Outback", "trim": "Premium",
    "mileage": 58900,
    "list_price": 21150.00,
    "distance_mi": 22,
    "source": "regional listing feed",
    "listed_on": "2026-08-24"
  },
  {
    "comp_id": "C-3",
    "vin_ref": "4S4BTAFC7M3201884",
    "year": 2021, "make": "Subaru", "model": "Outback", "trim": "Premium",
    "mileage": 55100,
    "list_price": 20980.00,
    "distance_mi": 31,
    "source": "regional listing feed",
    "listed_on": "2026-08-16"
  }
]
```

### `fixtures/state_rules.json`
```json
{
  "state": "AZ",
  "total_loss_threshold_pct": 75.0,
  "sales_tax_pct": 8.6,
  "title_fee": 15.00,
  "reg_fee": 55.00,
  "tax_reimbursed_on_total_loss": true,
  "offer_validity_days": 30,
  "salvage_retention_allowed": true,
  "lien_consent_required": true,
  "mileage_adjustment_per_mile": 0.085,
  "note": "Fixture values for a fictional insurer in a demo. Not a statement of Arizona law."
}
```

---

## 6. Tool split

**SAFE, no approval, read or compute only:**
`policy.lookup(phone)`, `claim.get(claim_id)`, `vehicle.get(vin)`,
`valuation.comps(vin, zip, radius)`, `lienholder.payoff_quote(loan_id, through_date)` (a quote,
it does not bind), `claims_history.get(vin)`, `state_rules.get(state)`,
`yard.storage_status(claim_id)`, `sandbox.run(code)`, `session.checkpoint()`,
`session.resume(phone)`, `notes.append(claim_id, text)` (internal, never customer facing).

**GATED, operator approves the exact wording or the action:**
`offer.state_settlement(claim_id, utterance, authorised_amounts[])` (the primary gate, and the
argument is the sentence itself), `settlement.accept(claim_id, amount, option)` (releases the
claim; pre-authorised only for amounts inside the approved utterance),
`payment.issue(claim_id, amount, method)`, `salvage.release_vehicle(claim_id, yard_id)` (the car
gets crushed, unrecoverable), `coverage.deny(claim_id, reason)` (adverse action, regulated).

---

## 7. Three things that make this fall flat

1. **Latency theatre.** If the five lanes return in 200ms the parallel argument evaporates on
   camera. Staggered fixture latency plus the serial versus parallel counter, or it reads as
   decoration.
2. **Rubber-stamp operator.** A one-second approve makes the gate a checkbox. The edit must change
   money, and the diff must hold the screen for three seconds or more. The salvage re-fire is what
   carries this.
3. **Sandbox as pocket calculator.** One line of arithmetic and the room calls it a prompt with
   extra steps. The script needs thirty to forty real lines (comp mileage adjustment, threshold
   rule, per-diem date math) written live rather than pre-baked, and the on-screen breakdown must
   sum exactly to the spoken figure. Section 4 exists so that it does.
