# Sealed documents

A sealed document's contents never reach the model provider, and neither does its name: the
provider is told a handle and a label (see "Agents are told" below). The agent asks typed questions about it
through `ask_documents`; a small worker model reads the document and answers; code checks each
answer against the document, runs the agent's program over the values, and decides what the
agent is shown. The code is in `packages/privacy-gateway/src/worker/`, the tools in
`apps/server/src/mcp/toolkits/privacy/`. This page records the decisions that the code cannot
explain on its own. The measurements behind them come from DoeDesk's evaluation of
sealed files, which is kept outside this repository.

## Decisions

**Sealed stand-ins are for display only, and there is no tool that runs a command with sealed
values.** A stand-in for a sealed value is restored in the assistant's own text and in files
finished by `fill_sealed`, never in a tool call. Restoring it in a command let a model print a
value back in another form (`echo [ID_X] | rev`) and read the result. The cost is real and
measured: every task that had to enter real values into a local program failed sealed (0 of 8,
against 8 of 8 unsealed).

A tool that fills sealed values into a command and returns only whether it succeeded was
proposed for that and ruled out (23 November 2026). Returning only an exit status closes the read-back of the command's output and
nothing else. The command is the agent's choice, so it can be `python3` or a script the agent
wrote, which writes every value it is handed into a workspace file the agent reads next; and an
honest agent does the same without meaning to, because the program it was asked to drive keeps
its state in the workspace and prints it when asked to verify. Neither the limit on clear
answers, nor the tripwire (which needs ten matching words in a row), nor the record would see
it. Sealing's promise is that a stated value does not reach the provider whatever the agent
does, and this tool would make that depend on the agent. Work that has to drive a local
program with real values keeps its documents masked instead of sealed, or the agent writes a
script through `fill_sealed` that the person runs. If this is reopened, the
conditions set then were: a yes or no only, never the exit code; no network at all; and the person
approving each command with its real values in view, not a standing switch.

**Sealing leaves the other-hosts rule alone.** An agent never holds a sealed value to send (see
above), and the rule does not stop a program that ignores the proxy settings. Tightening it for
sealed documents would contain nothing, and it would cut every agent on the device off from the
web, because the proxy cannot tell which folder a connection comes from. What an agent that sets
out to leak can still reach is the sealed store's key on disk and a finished file the person
saved into the folder; a host rule closes neither.

**Sealing a file moves it; only the person can move it back.** A file sealed from the folder
is deleted there once its bytes read back from the store (`sealedFiles.ts`), and unsealing
writes them back without overwriting anything. Neither is an MCP tool: an agent that could
unseal would read the file.

**Sealing removes the copies DoeDesk made, and leaves the person's repository alone.** A plain
folder gets a history of DoeDesk's own for undo (`folder-history`, reached through a `.git`
pointer in the folder), and every checkpoint in it held the file in plain, readable with
`git show`. The gateway reports every seal and unseal through one callback (`onSealChange`),
once for each action whatever it was: one file, several, a folder, or a sweep that found a new
file in a sealed folder, by the watcher, after a tool call or before a turn. For sealed files
`CheckpointStore.sealChanged` rewrites that history once without the paths, prunes the old
objects, and adds the paths to the history's exclude file. The exclusion stays after unsealing:
a restore removes what a checkpoint does not know, so a file that came back into a history
that had forgotten it would be deleted by restoring an older checkpoint. The cost is that
later edits to such a file are not in the changes view and cannot be undone. A history that
cannot be rewritten is dropped whole: sealing comes before undo. Captures and restores wait
while this runs, since pruning under a capture would lose its objects.

The callback is awaited, so the sweep before a turn ends only once the copies are gone. If
removing them fails, the paths are kept and tried again with every later change and at every
turn start, and no turn starts while one is left (`sealedHistory.ts`). That list is in memory:
after a restart a failed removal is not retried until the file is sealed again.

**Nothing in a sealed folder is checkpointed.** A file can lie in a sealed folder for a moment
before a sweep takes it, and the baseline checkpoint is captured beside the turn start, not
after it. So `CheckpointStore` leaves every sealed folder out of each capture, restore and diff,
in DoeDesk's own histories and in the person's repository alike. The order at turn start is
then: sweep the sealed folders, remove what the sweep sealed from history, build the note from
the resulting list, start the turn; the capture may run at any point of that.

**In the person's own repository only DoeDesk's checkpoints are rewritten.** Their commits are
theirs and stay as they are; the seal confirmation warns when those hold the file. But the
checkpoints under `refs/t3` are DoeDesk's, and they held the file as it was on disk, text never
committed included. On sealing, `CheckpointStore` exports only the commits reachable from
`refs/t3` and from nothing of the person's (branches, tags, remotes, stash, HEAD, reflogs),
drops the sealed paths from the commits whose message DoeDesk wrote, and imports the result:
only `refs/t3` refs move, and in a checkpoint the file is then whatever the person's commit
below it holds. The path is also kept out of later captures, restores and diffs
(`kept-out.json` beside the histories), after unsealing too: a restore would otherwise put the
committed version over the person's unsaved text.

The old checkpoint commits, their trees and the sealed file's versions are then unreachable but
still in the object store, where `git cat-file` and `git fsck --lost-found` find them. No prune
or gc is run, because either drops every unreachable object, the person's own included.
Instead the objects are named: those the old checkpoints reached that Git's own check
(`git fsck --unreachable`, whose roots are every ref, reflog and index) calls unreachable, and
their loose files are removed. A plain walk from the old checkpoints "not" the live refs is
not enough: it also names objects the new checkpoints still use. When some are in a pack,
`git repack -A -d` runs first, which turns every unreachable object of a pack into a loose one
and drops none, and the commit graph is written again when there is one, as Git does after it
prunes, or `git fsck` reports the removed commits. An object of the person's goes only when it
is the same object: a dangling blob or stash that holds exactly a version of the sealed file
that a checkpoint also captured.

The confirmation also says, once, when checkpoints show that chats ran while the file was
readable: what a chat read was sent then. That is a sign that turns ran, not proof that one
read the file.

**A file sealed again where it was takes the handle it had.** A chat knows a sealed file by its
handle, and a new one on every sealing lost it. The store keeps each unsealed file's handle by
its path (`formerHandles`) and gives it back when a file is sealed there again, changed or
not, as a file saved again in a sealed folder already kept it. The worker's kept answers are
deleted at unsealing and are keyed on a digest of the text besides, so none is served for a
changed file; the count of clear answers stays with the handle.

**Agents are told what is sealed with every prompt, not once per session.** Agents that were
told nothing looked for the file on disk, asked for a plain copy, or offered to restore it from
Git (`evals/mcp-tool-use`, sealed-files cases). A session's system prompt is fixed before the
person seals anything, and several providers load tool descriptions only on demand, so the
note (`buildSealedFilesInstructions`) goes ahead of each turn's prompt in
`ProviderTurnStartService`, the one place every provider's turn passes. A turn in a project
with sealed files is started through the delivery that carries pending context for that
reason; without it the adapter is called with the person's text alone. The note names the
files, their handles and `ask_documents`. A sealed folder is named with its files below it;
one with more than thirty is named with their count, and `list_sealed` gives the names and
handles, since no other tool does.

The note is prompt text, so everything in it reaches the AI company. A file's own name never
goes into it. What an agent is told about a sealed file comes from one function,
`sealedForAgents` in the controller, which the note and `list_sealed` both use, and it gives the
file's label: the name with the values a detector finds in it replaced by stand-ins
(`sealedLabels.ts`), or the handle and the file type when the person chose that or the name
could not be checked. The reasons, which the code cannot show:

- Leaving the name to the gateway's ordinary masking was not enough. A detector reads words,
  and a file name joins its words with underscores, hyphens, dots and capital letters:
  `Adel_AlAmri_1293040015_PulmonaryEmbolism.txt` went out with only its ID masked. The label is
  made by detecting over the name as written and over a form with those joins opened, then
  writing the stand-ins back where the values stood, so the label keeps the name's shape.
- A stand-in in a label is the one the same name gets in a message, so an agent can match
  "the chart of [PERSON_X]" to `[PERSON_X]_chart.txt`. The joined spelling becomes a known value
  too, so a listing or a message that writes the name the same way is masked from then on.
- It fails closed. A name is checked when its file is sealed and, failing that, before the next
  turn (`sealedFoldersBeforeTurn`); until then the handle and the type are sent. A sealed
  folder whose path has not been checked is left out of the note.
- Masking hides who, not what: a diagnosis in a file name is still sent. That is why the seal
  confirmation shows the label and offers the neutral one, and why a sealed folder remembers
  the choice for files that arrive later. A neutral file is listed under its sealed folder,
  whose path is told anyway, and not by where in the folder it lay.
- A masked folder name comes back from an agent as the name's words ("Adel Al Amri" for
  `Adel_AlAmri`), so `list_sealed` matches a folder by its words (`sealedFilesIn`).

The label is kept, and nothing bound for the AI company masks the name a second time
(`fileLabels.ts`). A second masking is not the first: read as prose, with a detector that
returns "Sara" and "Dossari" apart, `Sara_AlDossari_bank_letter.txt` becomes
`[PERSON_X]_AlDossari_bank_letter.txt` beside a label that hid both. The name can be written
by many hands: a chip the composer leaves in a message, the person's own typing, an agent's
tool (`git status` names a sealed file as deleted), a tool result that repeats a name the agent
built on the label. So the rule is enforced where all of it passes: before anything is
detected, `Pseudonymizer.mask` writes the kept label wherever a sealed file's name, its name
without the file type, or a folder of its path stands, in any case.

- A name sent as a handle and a type is written as that, but only as a whole file name, and not
  where another file in the folder has the same name: `notes.txt` sealed out of `hr/` must not
  rename the `notes.txt` an agent lists elsewhere. The folder's listing is read again after
  every seal change.
- On the way back the label becomes the name exactly (`FileLabels.spelling`). A stand-in's
  value is "Khalid Al Otaibi"; the file writes `Khalid_Al_Otaibi`. A stand-in with the label's
  text on both sides is written as the file writes it, so a tool is run with the real name and
  the text comes back to the gateway as the name, which is the label again. A streamed
  stand-in waits while the text after it can still become the label's.
- Nothing is sent when a file is sealed or unsealed: the checkpoint store drops its undo copies,
  and the provider learns of it from the next turn's note. `ask_documents` and `fill_sealed`
  answer by handle. `fill_sealed` returns the finished file's name, which the agent chose; a
  name built on a label comes back to it as that label.
- After an unseal the file is an ordinary file again. Its name is then read like any other
  file's name in a text, with its joins opened (the gateway's README, "Names of files and
  paths"), so what goes out is what its label was.

A native resume sends no prompt (Claude, Codex, Cursor and OpenCode resume natively; the
others refuse a resume that has nothing to send). A resumed agent that has not been sent the
current note, because a file was sealed since or the server restarted, is started with a
prompt instead, as a resume with pending context is.

**A seal or unseal is not the turn's change.** A turn's changes are the difference between two
checkpoints, so a file the person sealed or unsealed in between looked deleted or written by
the agent. `CheckpointStore` notes each one, a folder standing for its files, and leaves that
path out of a diff whose checkpoints lie on either side of it. The notes are kept in a file
beside the histories, the last 256 of them.

**The client resends what it displayed, so restoration is journaled.** After a reply is restored
for the person, the client sends that text back on the next turn with the real values in it.
`Restorations` maps a hash of the restored text to the text as the model wrote it and puts the
stand-ins back. It is keyed on the whole text: any rule that re-masks model-written text by
value would tell a model which of its guesses is right.

**Sealed values are not looked for in tool results.** They are looked for in what the person
types (people retype what they read) and, as a fallback when a client alters a restored reply,
in the model's own earlier text. They are not looked for in what a tool returned: a model could
write a file of guesses, read it back, and see which line became a stand-in. Sealed and ordinary
stand-ins are filed apart for the same reason, so a detector that finds a guess never hands
back a sealed stand-in.

**A stated number or date is filed under its value; everything a program returns gets a new
stand-in that says nothing of its kind.** One value written two ways must be one stand-in or
the agent wastes calls reconciling them. A program's results are different. A stable stand-in
would let a model add its own constants to a sealed value until the result matched another
stand-in. A stand-in that showed its kind (`AMOUNT`, `DATE`) would let a program return a
number for yes and a date for no. And a stated value passed through unchanged must not come
back as the stand-in the agent already holds, or `a if secret else b` would say which. So every
leaf of a result, a yes or no and "nothing" included, is `[OTHER_…]` and new each call. The
document's own spelling of an untouched value is still kept for what the person reads. A sealed
yes-or-no or choice field gets a new stand-in for each document for the same reason: two
documents with the same answer must not be matchable.

**The agent computes by sending a program, and the interpreter is ours.** The rule language
(`derived`) had no condition and no running total, and the tasks that needed them were the
ones sealing lost. It is gone; `program.ts` runs a restricted Python instead. It was written
here and not taken from elsewhere: Pydantic's Monty is a native binding with a worker process
per platform, needs a newer Node than the server supports, and holds plain values, so nothing
could say which documents a result came from; a Python parser from the editor world still
leaves the evaluator to write, on a syntax tree made for highlighting; the Starlark ports to
JavaScript are unmaintained; CaMeL's interpreter is Python and a research artifact. There is
nothing in ours to escape from: no import, no attribute but a fixed few, no input or output,
and every loop runs over a finite list under a step limit.

**A run shows only the shape of a trial over made-up values, and what it reveals.** There is
no tracking of control flow, so a program can choose among strings it wrote, keys it sets and
lengths of lists it builds by a value. The evaluation's scripted calls read a whole ten-digit
identifier that way for one counted answer. So each run goes first over
made-up values (`trialAnswers` in `program.ts`): what the model was told in clear stays
(handles, a yes or no, a choice, which fields are not stated, a list's rows and empty cells),
and every number, date, identifier and text is drawn at random. The real run's result must have
the trial's shape (keys, list lengths, which leaves are reveals and their answers; a sealed
list, below, has none of its own), or it fails.
The shape the model sees is then decided by no value, and what a run tells is whether it
worked and what it reveals. Values the program would call equal are drawn equal, or joins on
identifiers would fail; their stand-ins already show that, and identifiers are filed for
stand-ins by the program's own equality so the two agree. A field kept for the program
(`sealed`) hides even that, so it is drawn for each document. Dict keys come back sorted: the
order they were set in can follow a value. This is not secure multi-execution, which runs a copy
over made-up inputs and releases that copy's output: here the copy only fixes the shape, and a
real run that leaves it is refused. It is closer to TightLip's doppelganger (Yumerefendi et al.,
NSDI 2007), which runs a copy over scrubbed data and treats the point where the two differ as a
possible leak. The design was accepted, with its alternatives, on 23 November 2026.

**A trial value has a real value's form, and copies only what the model holds in clear.** Trial
identifiers used to begin `trial-`, so a program could pass every trial and fail only on the real
run. They are now drawn from forms documents use (digits alone, letters and digits, a dated
reference, digits in groups, a name in Latin or Arabic letters, a short code); numbers from one to
nine digits with up to three decimals; dates mostly from 2000 to 2039 and sometimes from 1950 to
2079; a kept list's rows from one to sixty. Of the real value the trial copies the type, which
values are equal, and for an identifier whether its stand-in says `ID` (four digits or more) or
`OTHER`, because the model holds all of those already. It copies nothing else: not length,
characters, digit script, magnitude, decimals or year. A trial's faults are told with their line
for free, and its shape is what the model sees for the price of a run, so a trial that copied a
length would let `{"ten": 1} if len(x) == 10 else {"other": 1}` read it for one answer, with
every other copied property in the same run. Two documents whose stand-ins look alike therefore
get the same trial from the same draws, which `program.test.ts` checks. Digit script and letter
case need no drawing: a program compares text as `canonicalText` does, which folds both. In a
kept list no stand-in was shown, so even `ID` or `OTHER` is drawn.

**One bit a run remains, and it is paid for.** No trial draws zero, a negative number, an empty
kept list or an empty cell, because ordinary programs would fault on them; a program can also
test for a form the trial rarely draws, or compare prose with what it was shown. So
`if x <= 0: 1 / 0` passes every trial and can fail the real run, and any test of a value can.
That one bit, whether the real run worked, is the channel no trial removes, and realistic
trials do not make it dearer: a trial that faults costs nothing and the program is sent again.
What bounds it is the charge. The cost is fixed by the trial before the real run: one answer
for a run that reveals nothing (it worked or it failed), and one plus enough yes-or-no answers
for each reveal's options, which is never less than the logarithm of all the outcomes a run
can have, "failed" among them (`costOf`, checked in `program.test.ts`). That holds whether or
not the program can tell the trial from the real run. Realistic values buy two smaller things:
honest programs that read an identifier's form no longer fail on a made-up one, and the mark
every trial carried is gone, though the forms no trial draws remain.

**What a program may reveal, and what a run costs.** `reveal(x)` shows a yes or no.
`reveal(x, [...])` shows which of 2 to 16 answers written in the program x equals. A string
the program wrote is no longer shown on its own: the program chooses which one. A run costs
one answer for whether it worked, and for each reveal as many yes-or-no answers as tell its
answers apart (one for a yes or no, two for four answers, four for sixteen). A lone yes or no
costs two: a run that can say yes, no or "failed" tells more than a bit, and charging one
would let a model read trits. The cost comes from the trial, so no value decides it; it is
charged to every document of the call, not only those read, because which are read can follow
a value. A run that would cost more than a document has left is not run, and the model is
told the limit, which says nothing a value decided. Reading a ten-digit identifier now costs
35 answers bit by bit, or 41 digit by digit. The record keeps the program's text with what it
revealed, or the private reason it failed, a shape that followed a value included.

**Nothing about a program may depend on a value without being counted.** A run is counted
every time, the same program twice included: the same text over a reworded field is a new
question. A program is not run when a document of the call has no answers left, or when a field
of the same call was withheld at the limit: a trial keeps the answers the model is given, so it
must have been given them. Fields are answered and counted before the program for that reason.

**A program's fault is told in full when no value caused it, and not at all when one may
have.** The text is parsed and checked (names, attributes, field names, and a `reveal()` of
what is plainly not a yes or no, such as `len()` or a number field) before the worker is
called, and costs no worker call. The trial's faults depend only on what the model was told
and on random draws, so they are told with their line and cost nothing; in the evaluation
those two caught all 95 failed runs, 87 of them a `reveal()` of a count or a number. A fault on
the real values returns one message and is counted, because which fault it was can depend on
a value (`if secret > 5: 1/0`). Made-up values can cause a fault real ones would not (a table
of dates that ends before a drawn date, `range()` over a count drawn in the millions, a
reference read ten characters deep that was drawn shorter); the message says it came from the
trial.

**What holds by construction, and what is only counted.** The document is never sent, a stated
value comes back as a stand-in, a stand-in is never restored in a tool call, prose is off
unless the person turned it on, and each answer is checked against the document. Those hold
whatever the agent asks. An answer that is not a stand-in (a yes or no, a choice, "not stated",
"could not be checked", a computed result that is shown) reaches the provider by design. Such
answers are counted against a single limit per document
(`clearAnswersPerDocument`, 100) and written to a record the person can open in Settings.
There is no per-value limit: an earlier version charged 8 bits per value and 256 per
document, and no setting of those separated ordinary work (tens of bits) from reading a
ten-digit identifier digit by digit (about 36). The limit stops a document being read out
wholesale. Do not describe it as protecting a short value from a hostile model; the record is
what the person has for that.

**"Not stated" counts, and past the limit a new question gets nothing.** A question can be
worded so that whether an answer comes back spells out a value, so "not stated" and "could not
be checked" are counted and recorded like a yes or no. For the same reason a document that has
reached its limit withholds every answer it has not given before, a stand-in included: a
stand-in where "not stated" would be refused says the value is there. An answer already given
is given again without being counted. A field asked `sealed` hides even that: stated or not, it
comes back as a stand-in (a list as `{"sealed": true}`), free while the document has answers
left and withheld when it has none.

**A list's size is shown, and a list is answered whole or not at all.** A `list` field reads
rows the document repeats; each cell is checked and sealed like a single answer. The number of
rows, and which cells are empty, come back in clear: the agent has to lay out one output row
per row, and hiding the count would force every row-shaped deliverable through a template
language. That shape is counted as one clear answer and recorded; each yes-or-no or choice in
a row is one more. One cell that fails its check fails the list, a list longer than `MAX_ROWS`
is not answered, and a list that would pass the document's limit is withheld entire: a list
short of a row would be totalled as if it were whole.

**A choice costs what `reveal()` of as many answers costs.** An enum answer, a field's or a
list cell's, is charged `choiceCost` of its options: one for two, two for four, four for
sixteen. Charged one, a sixteen-option enum read four bits for the price of one, where a
program's `reveal()` among the same options paid four. A stand-in, "not stated" and a list's
size are still one each.

**A list a value filtered is sealed whole.** `sealed_list(rows)` lets a program keep the rows
a value chose (`[r for r in rows if r["amount"] > 50000]`), which a result's shape would
otherwise refuse. It takes plain values or flat dicts with keys the program wrote, never a
value `reveal()` chose, and becomes an opaque value the program cannot index, loop over or
measure. In the result it is one fresh stand-in, and its shape is `sealed_list`, or the
columns the program named, whatever its rows: the trial and the real run agree however many
rows each kept, and the run costs nothing more. The rows go only into files `fill_sealed`
writes, which the model never reads back: a Markdown table in text, rows in a `.csv` or
`.tsv`, an array in JSON. Its inferred columns (the keys rows have) can follow a value, so they
too are seen only in the file.

**A finished file says where each value came from, on this machine only.** A sealed value
keeps its `source`: the document, field, checked quote and line, or for a computed value the
program and up to 24 document values it read. `fill` records the exact span of every value it
puts in (`text.slice(start, end)` is what it wrote, in text, CSV and JSON alike) and the store
keeps spans and the agent's draft encrypted beside the output. Only the person's client reads
them, through the `output` action; no source, quote or span is in what the agent is told.

**A finished file is revised from its draft.** `read_sealed_draft` gives the agent back what
it wrote for `fill_sealed`, stand-ins and markers in place, so a change the person asks for is
an edit and a second fill under the same name, not a rewrite from memory. The draft goes
through `maskKnown(draft, true)` on the way back: a real value the agent typed in comes back as
its stand-in, so reading a draft never carries a value it did not already hold.

**Text no reader sees is not read.** A document can carry instructions for a model that its
reader never sees. `sanitizeIngestedText` removes Unicode tag characters, control characters,
soft hyphens, zero-width spaces and byte order marks from every document's text, local or read
by the service; ZWNJ, ZWJ and directional marks stay, because Arabic and Persian need them.
Word runs that are hidden, hidden on the web or of size zero, HTML elements that are `hidden` or
styled out of sight, and comments in both are dropped before the text is taken. A reading
service's layout keeps its text as sent: its word positions are offsets into it.

**The agent is told to ask the minimum.** The tool description says so: a yes-or-no question
where one will do, no category the deliverable does not need, no asking again to double-check.
`DOEDESK_EVAL_SEALED_ASK_FREELY=1` serves the description without that paragraph, so its effect
can be measured on the same tasks.

**The agent is told to ask once, and a reworded instruction still asks again.** Every call
sends each listed document to the worker whole. In the recorded sealed runs a document was read
1.67 times a task (751 reads of 450 documents), mostly because the agent asked what kind each
document was and then asked each kind for its details, so the description says to ask the kind
and the details together, with the program. Leaving the instruction out of the memory's key was
measured on the same runs and rejected: it would have saved 2 of those 751 reads, because an
agent that asks again also adds or rewords a field, and where the same field was asked under
another instruction the worker's answer differed in 10 of 323 cases. For the same reason the
answers kept across sessions pay only where a question is put again in the same words, as a
thread that goes on after a restart can: when whole tasks were run again from the start, the
agents reworded nearly every field, and 2 of 899 reads would have been saved.

**The tools stay offered while a worker is configured.** They used to be hidden when the
worker had just failed twice, which made them vanish mid-task together with `fill_sealed`. A
failing worker now answers with how long to wait.

**In typed text only the copied passage is withheld.** A request that quotes a clause of a
sealed document loses the clause and keeps the request. A tool result that holds sealed text is
still replaced whole.

**A "no" needs no passage.** The worker must quote the passage behind a number, a date, an
identifier and a "yes". A "no" usually has nothing to quote, and requiring a quote doubled the
worker calls. A choice without a passage is accepted after the worker has been asked once more.

## Traps

- The worker endpoint can refuse its own strict JSON output (`json_validate_failed`) for one
  identical call in several. `runJob` retries at once and drops to JSON-object mode after two
  such failures. Do not treat a 400 from the worker as final without reading its code.
- `fill_sealed` writes plain digits and ISO days into `.json`, `.jsonl` and `.csv` files unless
  a marker says `|written`: "1,284,500.75" is not a JSON number. A `.csv` or `.tsv` file gets
  the value as it is and nothing more: no quotes are added and none inside a value are doubled,
  so a name that holds a comma or a quote shifts its row unless the agent quoted the field, and
  nothing checks the finished file.
- A figure an account writes in brackets is read as negative and a heading's scale is applied
  in `checkField`. The tool description tells the agent so; if that sentence is cut, agents
  negate and multiply a second time. Brackets are not a sign everywhere: `bracketsAreSign`
  leaves "forty-five (45) days", "Article (7)", "14(2)" and "(30) يوماً" positive. It decides
  from the words beside the brackets, so a row label that ends in a number word
  ("Segment one (1,250)") is read as positive.
- A program's arithmetic is Python's, binary noise and all. The noise is taken off
  (`withoutNoise`, fourteen digits, which keeps the halalas of an amount in the billions) only
  where a number is compared, rounded, used as a key or
  written, so `274477.23 - 75000` is written `199477.23`, `0.1 + 0.2 == 0.3` is true and
  `1 / 3 * 3 == 1` stays true. Cleaning every step instead broke the last. `round()` rounds a
  half away from zero on the clean value, which is what documents mean and not what Python
  does. A stated number keeps every digit the document wrote.
- In a `.json` or `.jsonl` file `fill_sealed` writes a stand-in or a marker that is a value of
  its own as the JSON its value needs, quoted by the agent or not, with a form or without (`fillJson`):
  the agent knows a stand-in, not whether it holds a number, a yes or a name. A number is a
  number, a yes or no `true` or `false`, and a date, text or `|written` a string. One inside a
  longer string is escaped into it. The name of a member stays a string.
- A marker is anything between double braces that starts like a name, and its reference is
  looked up as written. A program's result has the keys the program gave it, and the tool's
  description advises keying by handle, so `{{calc.pay_DOC_1}}` and `{{calc.rows.DOC_1.days}}`
  are ordinary markers; a grammar of lower-case field names passes them over without filling
  or naming them. One that names no value stays in the file, is listed in `unknownMarkers`, and
  the result says `finished: false`, which is also what keeps the file's card out of the reply
  (`sealedOutputFromToolItem`). A file of another templating language that writes `{{name}}`
  for its own purposes is reported as unfinished too.
- What `fill_sealed` tells the agent must not depend on a value. Whether a `.json` or `.jsonl`
  file is JSON is judged from the text the agent wrote (`isJsonTemplate`): it is filled with one
  made-up string for every stand-in and marker, and a string fits only where any value does, so
  the verdict is the same for every value. `-[X]` is JSON only when X is a number that is not
  negative, so it is refused whatever X is. The finished text is parsed as well before it is
  kept; the two can differ only if the filling is wrong. A value filled in is not read again for
  stand-ins: a program's text can spell made-up ones, and the unknown ones and the count of
  those filled go back to the agent. A marker on a program's value takes any form asked of it,
  because which forms it has would tell its kind.
- A stand-in in what the agent sends to `ask_documents` is restored for the worker, with two
  exceptions that were leaks: never in an enum's options, which are the answer itself, and never
  for a file the agent can read, whose answers go back in clear.
- An answer that passed its checks is remembered, so the same question does not call the
  worker twice: in memory for the session (`remembered` in `sealedWorker.ts`) and, encrypted
  beside the sealed store, across sessions (`keptAnswers` in `store.ts`). The key is the
  project, the document's text, the worker (route and model), the instruction and the field; a
  reworded instruction asks again. What is kept on disk is the worker's reply, not the checked
  answer: it goes through `checkField` again against the document before it is used, so a
  remembered answer is one a fresh reply of the same words would be given today, and a kept
  reply that no longer passes is asked for again. Memory stands in for the worker call and
  nothing after it: the answer is sealed, counted against the document's limit and recorded by
  the same `sealBatch` call as a fresh one. A document keeps its last 256 replies; they go with
  the file when it is unsealed or saved again, and all go when the worker's route changes. An
  account that loses DoeDesk Cloud's worker has no route, so its kept answers go too and asking
  fails; nothing of a batch that was refused or found the worker busy with nothing read is kept.
- Two questions that arrive at once about the same document and field share one call
  (`inFlight`): the later one waits and then asks only for what is still missing.
- A number field may copy an amount written in words ("ستمئة وأربعة وتسعون ألف"), which
  `parseNumbers` reads only when the copied text holds no figure. Contracts say which prevails
  when words and figures differ, and the two can differ.
- Nothing checks that a list holds every row, and no sound check was found. Each row the
  worker returns is found in the document; a row it leaves out is not noticed. The rows of a
  list are the ones its description picks ("every invoice past due"), so the document's layout
  cannot count them: a row between two returned ones may be rightly left out, and subtotals and
  headings look like rows. A count asked beside the rows comes from the same reading and misses
  the same row; a count asked in a second call cannot be checked against the document either,
  doubles the worker calls, and its agreement proves nothing. The worker is told to leave no row
  out. Where the document states a total, the agent can ask for it as a number and compare the
  rows' sum with it in a program, for one answer.
- A list relies on the worker's host more than a single field does: an array of objects in the
  strict schema, room for a few dozen rows of output (`outputBudget`), and the 60-second limit
  per document. A host without strict schemas falls back to JSON-object mode as before; a slow
  one will run out of time on a long list. The list rules are sent beside the fields and only
  when a list is asked for, so the system prompt that was measured is unchanged.
- DoeDesk Cloud hosts a worker again, per account region (decided 24 November
  2026). The app never maps a region to a host: it sends hosted requests to DoeDesk Cloud with
  the account's sign-in, and the cloud resolves the upstream from the account. Everything the
  app shows about a region's worker except the copy that names its operator comes from
  `/v1/me`, so the cloud can change a region's model without an app release; a change of
  operator needs new copy and a new sub-processor entry anyway.
- The hosted worker is offered under an agreement, switched on per account by DoeDesk Cloud and
  the same in every region (decided 24 November 2026). The app learns it
  from `worker.entitled` in `/v1/me` and the sign-in answer, and anything else reads as not
  included: an older DoeDesk Cloud, one not deployed with it, a missing field. Without it the
  hosted worker is never the default and never offered, and the account region is hidden,
  since it governs nothing else.
- Who reads sealed files is `workerKindOf` in `controller.ts`: the stored choice
  (`providers.worker`, kept apart from the choices for reading and detection), or, with none
  stored, DoeDesk Cloud's worker only for a signed-in account that has it. A stored choice of the hosted worker on an account without it
  reads as none, never as the person's own server: losing the worker must not send a sealed
  file anywhere the person did not choose. The files stay sealed, DoeDesk Cloud answers
  `worker_not_included` to a call made before the app knew, and that answer ends the batch and
  marks the account, so the next file is not sent at all.
- When the worker changes (region, kind, or own server), `apply` drops the answers remembered
  from the last one, in memory and on disk, and its failure count. Without that, the record of
  clear answers would name the new worker for an answer the old one gave. Another model at the
  same route is not a route change: its answers are kept apart by the key instead.
- DoeDesk Cloud queues hosted calls per region, for all accounts, because the upstream account
  takes only a few at once and counts refused calls against its minute. For the hosted worker
  only (`WorkerEndpoint.queue`): the number of lanes is the server's, not 16; a document's 60
  seconds run while its call is with the worker, with the server's wait allowed on top of each
  call and the wait it reports given back; and a "busy" answer ends the batch without another
  call and is not counted by the breaker or against the two askings of a question. One
  question's time grows with the rounds it needs (`queuedBatchMs`: twenty seconds a round, two
  to ten minutes). Documents not reached come back as waiting with the answers that were
  given, and asking again sends only those, because answers are remembered per document.
- The hosted worker's tools are offered once a file is sealed or the person chooses the worker.
  Offering them to every signed-in account would change every agent's tool list for a feature
  most have not used.
