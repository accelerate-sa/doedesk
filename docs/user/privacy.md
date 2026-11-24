# Privacy gateway

DoeDesk keeps personal data away from the AI model. Before a request leaves your computer, names,
phone numbers, IDs, emails, IBANs, addresses and organization names are replaced with stand-ins
such as `[PERSON_FBJD2]`. The model works with the stand-ins. When it answers, writes a file or
runs a tool, the real values are put back on your computer, so what you see and what lands on disk
is real.

## How it works

- A small proxy runs on your computer, on a local port. Every agent DoeDesk starts is told to send
  its traffic through it and to trust its certificate. Your system's trust settings are not
  changed.
- The proxy opens requests to model providers only. Other traffic passes through untouched.
- The table that maps real values to stand-ins is the vault. It is a file in the DoeDesk data
  folder (`privacy/vault.json`) and never leaves the computer. Stand-ins are random; one cannot be
  turned back into a value without the vault.
- If a request cannot be checked, for example because the detection service is unreachable, it is
  not sent. DoeDesk tries again for a few seconds first; after that the agent shows an error that
  says what happened and what to do, and you send your message again.
- If your computer is set to use a proxy (`HTTPS_PROXY`, `NO_PROXY`) or its own certificate
  bundle (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and similar), DoeDesk's proxy sends through yours
  and adds your certificates to the ones agents trust. DoeDesk reads these when it starts. What
  goes through your proxy: every request to an AI company, and DoeDesk's own calls to the
  detection service, the reading service, the worker and DoeDesk Cloud. A host named in
  `NO_PROXY`, and an address on this computer, is reached directly. DoeDesk never goes around
  your proxy: if it asks for a name and password DoeDesk was not given (put them in the proxy
  address, as in `http://name:password@proxy:3128`), or refuses, the request is not sent, and
  Recent requests and the chat say what the proxy answered.
- The names of files and folders are checked too, wherever they are written: in your messages,
  in what a tool prints, in a command. A person's name joined to other words by underscores,
  hyphens or capital letters, as in `Sara_AlDossari_bank_letter.txt`, is found and replaced, and
  the name is put back exactly as it was on your computer. So is the part of a company's name
  or of a record number that DoeDesk already masks: `quote_helvetia.txt`, or
  `amendment_mnt_8042.txt` for agreement MNT-2025-8042.
- Images and PDFs are not sent to the model. Their text is read out, masked, and sent as text. If
  a file cannot be read it is withheld and the model is told so.
- Usage reports that agent programs send to their vendors are passed on. They hold timings,
  counts and the names of tools, not your messages or files; every value DoeDesk already knows
  is replaced by its stand-in in them, and they are not checked for new values. Claude Code's
  reports can be switched off in **Settings → Privacy → Advanced**.

**Settings → Privacy** shows whether masking is on, the recent requests with how many values were
masked in each, and the folder's sealed files. What few people change is under **Advanced**: who
reads sealed files, the other-hosts rule, masking per AI company, how images are sent, and the
vault.

### When a word is masked that should not be

A detector can take an ordinary word for a name. DoeDesk leaves the words of code and the names
of files in your project alone, but other words can still end up in the vault. To stop that, open
**Settings → Privacy → Stand-ins on this computer**, show the list, and choose **Stop masking**
next to the word. From the next request the word is sent to the AI as written, in every
conversation, including earlier messages of a conversation that is still open. Its old stand-in
still turns back into the word if the AI writes it. What was already sent cannot be taken back,
so do this only for words that are not personal. **Mask again**, under **No longer masked**,
undoes it. Values of sealed files cannot be released.

### Web pages and search results

When an agent searches the web or fetches a public web page, the names on that page are not the
confidential part of your work, and replacing them makes research hard. So those results are not
searched for new names: only values DoeDesk already knows, such as a name you typed, are replaced
in them. This applies to `https` pages on public host names only. A page on your own network, a
page fetched with a sign-in, and the results of every other tool are checked in full. To have web
results checked in full as well, switch on **Settings → Privacy → Web pages and searches**.

## Seeing it in a chat

- Beside the message box, a small shield says where this chat stands: **Masked**, **Not masked**
  (masking is off, or off for this AI tool), **Masking not confirmed** (DoeDesk has not been
  tested with this AI tool, or rewrote nothing in the chat's last turn), or **Not sending**
  (requests are held back, for example until masking is set up). Click it for the reason.
- Under each answer, one line says what DoeDesk did for that turn, such as how many values it
  replaced. **Inspect** lists them by kind, and **Show real values** puts each real value beside
  its stand-in. The real values are read from the vault on the computer the chat runs on.
- When the AI asked about sealed files in a turn, the same line names them and says how many
  answers reached the AI as they are. **Inspect** lists each of those files with its handle, and
  each such answer with the question that was asked. On another computer the files show by handle
  only: their names and the answers stay on the computer that holds them.
- The counts are of what DoeDesk found and replaced. They say nothing about a detail it did not
  recognize, which was sent as written. Each turn sends the whole chat again, so a value from an
  earlier message is counted in later turns too.
- In your messages and in the replies, a value that a turn sent as a stand-in has a faint tint
  once the turn has finished. Rest the pointer on it, or tap it, to see the stand-in the AI
  company received and its kind. The tint changes nothing in the text: what you select and copy
  is exactly what was written. A chat that runs on another computer, and a shared chat, show no
  tint: the real values stay on the computer the chat runs on.

## Seeing it in a file

Open a text file, a table, a PDF or a spreadsheet in the file panel and press the shield in the
panel's header, **Highlight what DoeDesk replaces**. The values in the file that DoeDesk has
replaced before are tinted; the pointer shows the stand-in sent in each one's place. The switch
stays as you leave it.

The highlight shows only values DoeDesk already knows. It does not check the file: that happens
when an agent reads it, and anything DoeDesk does not recognize then is sent as written. A file
with nothing highlighted is not a file with no personal details.

Scanned pages and images have no text to highlight. Settings → Privacy → **What was sent in
place of files** shows the copies that were sent in their place. In a web browser, PDFs open in
the browser's own viewer and are not highlighted; the desktop app highlights them.

## Finding the names

Fixed-format identifiers (phones, national IDs, IBANs, emails) are found on your computer.
Names, organizations and addresses need a detection service. Choose one in the welcome page or in
**Settings → Privacy**:

- **DoeDesk Cloud.** Sign in with an account. The text being checked is sent to DoeDesk Cloud for
  detection and is not stored there.
- **Your own service.** Enter its address. Text is sent only to that address.
- **Without masking.** Nothing is checked or replaced: messages and files reach the AI as
  written. You can turn masking on later in **Settings → Privacy**.

With a worker connected (see Sealed files), a second check can be switched on in **Settings →
Privacy → Advanced**. The worker then reads each message before it is masked and finds reference numbers,
districts and similar details that point to a person. Messages then go to the worker as written,
through DoeDesk Cloud when the worker is the one it hosts, and replies start a little later. It
is off unless you switch it on.

### Running your own service

Any HTTP service that answers these two calls works. A bearer token is optional.

`POST /v1/detect`

```json
{ "texts": ["Applicant: Khalid Al-Otaibi, phone 0551234567."] }
```

answers one result per text, in order:

```json
{ "results": [{ "entities": [{ "start": 11, "end": 27, "kind": "PERSON" }] }] }
```

`start` and `end` are offsets in UTF-16 code units, as in JavaScript strings. `kind` is one of
`PERSON`, `ORG`, `LOCATION`, `ADDRESS`, `PHONE`, `EMAIL`, `ID`, `IBAN`, `ACCOUNT`, `DATE`, `URL`,
`OTHER`. DoeDesk sends at most 25 texts of at most 4,000 characters per call.

`POST /v1/ocr` (optional) takes an image or PDF as the request body, with its media type in
`content-type`, and answers `{ "text": "..." }`. Without it, images and PDFs are withheld.

## Sealed files

Masking hides names inside text the model still reads. Sealing keeps a whole file away from the
model. A sealed file is stored encrypted in the DoeDesk data folder. Its contents are never sent
to your AI company. What is sent about it is a short handle such as `DOC_3` and a label, so the
agent can tell your files apart (see "What your AI company is told about a sealed file" below).
When the agent needs something from the file, a small second model, the worker, is sent the file, reads it whole and answers typed questions: a date, an amount, a yes
or no, one of a list of options, or the rows of a table such as an invoice's line items. You
connect the worker: a model on your own server, or a hosted service you have a key for. An
organization can instead take a worker that DoeDesk Cloud manages in its region, under an
agreement (see Who runs the worker).

- Each answer must come with the passage that states it, and DoeDesk checks that the passage and
  the value are in the file before using them. An answer that fails the check is not passed
  on.
- Numbers, dates and reference numbers reach the agent's model as stand-ins. To compute with
  them the agent writes a small program, which DoeDesk runs on your computer over the real
  values, including Hijri dates and Arabic-Indic digits. The results come back as stand-ins too,
  and the model is shown only what the program asks to be shown: a yes or no, such as "late",
  or which of a few answers written in the program a result is, such as "high" or "low". The
  agent can also keep a yes-or-no or a category sealed when it needs it only for the
  calculation.
- The real values appear in what you read and in the files the agent fills in for you. A
  finished file shows in the agent's reply with **Open** and **Save**; it is kept in the DoeDesk
  data folder, not in your folder, so the agent cannot read it back. Saving it puts a copy where
  you choose. Finished files are also listed in **Settings → Privacy**. The real values are never
  put into a command or another tool call.
- A yes or no, a choice from a list and "not stated" reach the agent's model as they are. Each
  sealed file gives a limited number of such answers, and every one is kept for you: **Settings →
  Privacy → Show answers** lists which file was asked, what was asked, the answer and when,
  and every program the agent ran with what it was shown. A program counts against every
  file it was run over: once, and once more for each yes or no it shows (a choice among
  several answers counts as the yes-or-no answers it takes). Past the limit the agent is told so;
  reset it there if the work is legitimate. The limit stops a file being read out wholesale.
  It does not stop an agent
  that sets out to learn one short value, such as an identity number, from a few dozen
  questions; the list of answers is where you would see that.
- A sealed value cannot be put into a command or a tool. Work that has to feed real values into
  another program needs those files masked rather than sealed.

### Sealing and unsealing a file

Seal a file where you meet it: right-click it in the folder's file list (or use the row's menu
button) and choose **Seal…**, press the seal button in the header of an open file, or press
**Seal** on a file or an image you attached to a message. A PDF or an image is read by your reading
service first, as it is for masking, and the worker reads that text. With a DoeDesk Cloud
account the reading service is DoeDesk Cloud, in Saudi Arabia, whichever worker you use. A file
you only mentioned with `@` is sealed from the file list or from its header. Before you confirm,
DoeDesk tells you who will read the file: with your own server, its address; with DoeDesk
Cloud's worker, your account's region and where the file's text is sent, with **Change** beside
the region. If nobody is connected to read sealed files, it asks for your own server's address
first. An account that has DoeDesk Cloud's worker can choose it there instead.

### What your AI company is told about a sealed file

The agent is told each sealed file's handle, a label for it, where it was, and whether it can be
asked about yet. All of that reaches your AI company. The file's own name does not.

- **The label is the file's name with what the detection service finds in it replaced by
  stand-ins**: a person's name, an ID number, a phone number and the like.
  `Adel_AlAmri_1293040015_PulmonaryEmbolism.txt` is sent as
  `[PERSON_K2M4P]_[ID_8AXB8]_PulmonaryEmbolism.txt`. A number that is none of these is sent as
  it is: `leave-request-0412.txt` and `salary-review-2026.txt` keep their names. The exception
  is the last number of a record number written in the file itself: `amendment_mnt_8042.txt`,
  whose text names agreement MNT-2025-8042, is sent as `amendment_[ID_7QK2M].txt`. That is
  found when the file is read, so the confirmation before sealing may still show the number;
  the label under the file in **Settings → Privacy** is the one sent. DoeDesk looks
  for these values in the name
  as you wrote it and with its joined words taken apart, so a name joined by underscores,
  hyphens, dots or capital letters is found too. The folders in the file's former path, and the
  path of a sealed folder, are checked in the same way.
- **Masking hides who, not what.** Everything else in the name is sent as it is: a diagnosis,
  the name of a deal, the kind of document, a date, a reference number. In the example above
  the diagnosis is still sent.
- **You can send a neutral label instead**: the handle and the file type, such as `DOC_3.txt`,
  and nothing of the name or the path. The confirmation shows the label that will be sent
  before you seal, with a box to send only a neutral label: for the file, for all the selected
  files, or for a folder. For a folder the choice also holds for files that arrive later, and
  the folder's own path is still sent, masked, because the agent can list the folder anyway.
  You can change a sealed file's label afterwards in **Settings → Privacy**, under the file.
- With a neutral label the agent can still ask about the file and compute over it by its
  handle. What it loses is the ability to tell which file you mean when you name one, or to
  pick the relevant file by its name: say the handle, or let it ask each file what it is.
- A name that cannot be checked, because the detection service did not answer, is sent as a
  neutral label and checked again before the next turn.

- A file in the folder moves out of the folder, so the AI cannot open it there. DoeDesk keeps it
  encrypted in its data folder. **Unseal** puts the same file back where it was. If another file
  of that name has appeared meanwhile, yours comes back beside it as `name (unsealed).ext`.
- A file in the folder is sealed whether or not DoeDesk can read it. One it cannot read, such as
  a video, a spreadsheet, a scan with no text, a file over 20 MB, or a PDF met while your reading
  service is not answering, moves out and is kept encrypted like any other. The list shows it as
  **Sealed, but cannot be asked about yet** with the reason, and the AI is told the same if it
  asks. **Try reading again** reads it from the kept copy, and DoeDesk also tries by itself the
  next time the AI asks about a file the reading service had not answered for. DoeDesk tells you
  before you confirm when a file is of a kind it cannot read.
- A file attached to a message reaches DoeDesk as a copy. Before you confirm, DoeDesk looks in
  the folder for the file itself. If exactly one file there has the same contents and the same
  name, that file is sealed: it moves out of the folder like any other. If DoeDesk cannot tell
  which file is meant, or the file is not in the folder, only the attached copy is sealed, and
  the confirmation names the files in the folder that your AI can still open; seal those from
  the file list with **Seal…**. A file that is nowhere in the folder stays on your computer
  untouched. A copy that cannot be read is not sealed, and DoeDesk says why: sealing it would
  take nothing away from the AI.
- Sealed files are listed under the folder's file list and in **Settings → Privacy**, each with
  **Unseal**. The short name beside each one, such as `DOC_3`, is what the AI calls it. A file
  you unseal and later seal again in the same place gets the short name it had, changed or not,
  so a chat that knew it still does. What the worker had answered about it is not kept across
  that: it is asked again.
- If the folder is your own Git repository and your own commits hold the file, DoeDesk says so
  before you confirm: those earlier versions stay in Git's history, where the AI can read them,
  and Git shows the file as deleted until you unseal it. DoeDesk does not change your commits.
- DoeDesk keeps its own copies of your files so you can undo a turn: in a history of its own
  for a folder that is not a Git repository, and beside your commits in one that is. Those
  copies include text you never committed. Sealing a file removes every copy of it that DoeDesk
  made, in both kinds of folder, and DoeDesk keeps no copies of that file afterwards, also once
  it is unsealed: changes to it no longer appear in the changes view and undo leaves it as it
  is. The same holds for several files sealed at once, for a sealed folder, and for a file that
  turns up in a sealed folder later. Nothing in a sealed folder is copied for undo at all.
- Sealing cannot take back what was already sent. If chats ran in the folder while the file
  could be opened, DoeDesk says so before you confirm.
- While a folder has sealed files, a line above the message box states what sealing costs: work
  that uses them is slower, weaker for drafting long text, and closed to shell commands. It
  shows once in each chat until you dismiss it.

To seal several files at once, select them in the file list and choose **Seal N files**, in the
bar under the list or in the menu of one of the selected rows. One confirmation covers them all
and says how many files your server will read, and how many are sealed without being read.

When you attach a text file or a table that holds many ID numbers, IBANs or phone numbers, or
whose header row names payroll or identity columns, DoeDesk asks under the attachment whether to
seal it instead. It decides on your computer, from the file itself, and sends nothing anywhere
to do so. A PDF or an image is not checked this way, because reading one needs your reading
service. The question never blocks sending.

Only you can seal or unseal. Agents have no tool for either.

### Sealing a folder

Right-click a subfolder in the file list and choose **Seal folder…**. A sealed folder holds
nothing an AI can read: every file in it is sealed, and every file that appears in it later. The
confirmation says how many files there are and which server will read them. The folder you
opened in DoeDesk cannot be sealed itself, only a subfolder of it. A folder that holds a Git
repository of its own, or more than 5,000 files, cannot be sealed.

- The folder stays where it is, and DoeDesk remembers that it is sealed. DoeDesk watches it while
  it runs, checks it again right after every command, file change and tool call of an AI, and
  checks it before every turn of an AI, because files can arrive while DoeDesk is closed.
- A turn does not start while the folder holds a readable file. If a file is still being copied
  in when you send a message, DoeDesk waits up to two minutes for the copy to finish and says so
  above the message box; it never removes a file that is still being written. If the copy is not
  done by then, or a file cannot be moved out because another program has it open, the turn ends
  without starting the AI and says which file is in the way. Send the message again afterwards.
- A file DoeDesk cannot read is sealed too, as described above, hidden files included. Only the
  small files your system writes about a folder (`.DS_Store`, `Thumbs.db`, `desktop.ini`) stay.
- A document saved again under the same name replaces the sealed one and keeps its short name,
  such as `DOC_3`, so what the AI knew it by still works. The earlier version is not kept: this
  is saving over a file, and the folder cannot ask you first because it looks empty.
- In the file list the folder's row says how many of its files are sealed, such as
  `contracts 40 sealed`. Under the list and in **Settings → Privacy** the folder is one row that
  opens to its files and their handles.
- A sealed folder does not stop an AI from writing a file into it, except Claude's own file tools,
  which are refused; whatever any AI writes there by another way is sealed within moments, so no
  AI can read it back. Finished files still go through `fill_sealed` to **Settings → Privacy**.
- **Unseal folder** puts every file back as it was, byte for byte, and stops sealing new ones. A
  file of a sealed folder is not unsealed on its own: it would be sealed again at once.
- A chat that works in its own copy of the folder, a Git worktree, has other files. Seal the
  folder in the project's own folder.

### What to expect

We measured sealing on 120 tasks in English and Arabic against the same agent reading the
documents itself. No name, identity number, account number or other identifier reached the
model's provider in any sealed run. Registers and calculations across documents came out as
correct as unsealed work. Sealed work took about twice as long. Letters and memos written from
sealed files stated the right values and read worse, and work whose logic the arithmetic of
that version could not express lost accuracy; programs were added for that and are not in these
measurements. The figures are in
[the article](https://doedesk.com/blog/sealed-documents).

### Who runs the worker

The worker reads sealed files whole, with nothing masked. Choose who runs it in **Settings →
Privacy → Advanced → Who reads sealed files**:

- **My own server**: any address that supports the Chat Completions or Responses format, with a
  model name and, if the server asks for one, a key. Sealed files then go from your computer
  straight to that address and not to DoeDesk Cloud. That can be a model on your own machine,
  or a hosted service you have a key for; with a hosted service, sealed files go to that
  service. If you are signed in to DoeDesk Cloud for masking, it still reads PDFs and images
  when you seal them.
- **None**. Masking works as before and sealed files stay sealed; agents cannot ask about them
  until a worker is chosen again.
- **DoeDesk Cloud**, for organizations. A worker that DoeDesk Cloud manages in your region is
  offered under an agreement and switched on for the organization's accounts; the choice
  appears only for a signed-in account that has it, and is then what the account uses unless
  you choose otherwise. Each time your AI asks about a sealed file, DoeDesk Cloud's server in
  Saudi Arabia receives the file's text and passes it to the worker model for your account's
  region, and passes the answer back. DoeDesk Cloud stores neither; it keeps counts of
  requests and tokens. To ask about it for a team, write to hello@doedesk.com.

Masking does not depend on any of this: it runs automatically for every account, with DoeDesk
Cloud or with your own detection server.

Settings shows which worker is in use, whether it is answering and, for DoeDesk Cloud's worker,
its region and model.

If your account stops having DoeDesk Cloud's worker, your sealed files stay sealed and
encrypted on your computer and nothing is sent anywhere else, not to DoeDesk Cloud and not to
another server. Settings and the chat's privacy status say the worker is not included, and
agents are told that no worker reads sealed files now. Connect your own server to ask about
the files again, or unseal them.

### Your account's region

An account that has DoeDesk Cloud's worker has a region. It decides one thing: where that
worker runs. Other accounts are not shown a region, because nothing else depends on it.

| Region         | The worker model runs at                                             |
| -------------- | -------------------------------------------------------------------- |
| Saudi Arabia   | deep.sa, in Saudi Arabia according to deep.sa                        |
| European Union | Not offered yet. An account in this region seals with its own server |
| Global         | OpenRouter's global endpoint, with no region restriction             |

DoeDesk Cloud's worker is always an open-weight model: one whose weights you, or DoeDesk, can
run on hardware under your own control. DoeDesk Cloud never passes a sealed file to an AI
company's own model.

DoeDesk Cloud does not offer a worker in the European Union region yet. An account in that
region is told so in Settings and before it seals a file, and DoeDesk sends nothing to another
region's worker in its place. Connect your own server ([Who runs the worker](#who-runs-the-worker)) to seal and ask about
files.

Whichever region you choose, your account, detection, the reading of PDFs and images, and the
worker's requests on their way all pass through DoeDesk Cloud's one server in Saudi Arabia.
If your rules need a sealed file's text to stay in one country, use your own server for detection
and for the worker.

The region is set when the account is created, from where you signed up: a Saudi mobile number
or a sign-up from Saudi Arabia starts in Saudi Arabia; the EU, the EEA, the United Kingdom and
Switzerland start in European Union; everywhere else starts in Global. Signing in later from
another country does not change it. Change it in **Settings → Privacy → DoeDesk Cloud account →
Region**, beside the worker, or in the question DoeDesk asks before sealing a file.

- A change takes effect with the next question about a sealed file. Files already sealed stay
  as they are, encrypted on your computer, and their next questions go to the new region. If
  you have sealed files, DoeDesk says so and asks before changing.
- DoeDesk never sends a sealed file to another region's worker. If your region's worker is not
  answering, agents are told it did not answer, Settings and the chat's privacy status say so,
  and masking carries on. You can wait or use your own server.
- A region's worker answers a limited number of questions at a time, for everyone who uses it,
  and people take turns. When it cannot take a question within a few seconds it says it is
  busy: Settings and the chat's privacy status show "busy" with how many are waiting, your AI
  is told to ask again shortly, and nothing is sent to another region. Busy is not a fault.
- Each answer that reached your AI as it is, is kept with the worker that gave it: the region,
  or your own server's host. Earlier entries are not rewritten.
- DoeDesk Cloud keeps your region, when you last changed it and the history of changes. They
  are in **Download my data** and are deleted with the account.

### Other hosts

Commands an agent runs can reach the internet, as they do without DoeDesk. Sealing a file
does not change that: a sealed value is never put into a command, so an agent has none to send.

If you want a tighter rule, **Settings → Privacy → Advanced → Other hosts** limits agents to the
hosts you list, or to AI hosts only. When that rule refuses a host, the chat says which one and
lets you allow it until DoeDesk is closed, or always. The rule covers programs that use the system
proxy settings; a program that opens its own connection is not stopped by it.

## Which agents are covered

The gateway rewrites the request formats used by Claude, Codex and ChatGPT, Gemini-based agents,
and agents that speak the OpenAI chat format (OpenCode, Pi and others). Cursor's agent uses a
format the gateway cannot rewrite, so its model traffic is blocked while masking is on.

Only Claude and Codex have been measured end to end. For any other agent the shield beside the
message box reads **Masking not confirmed** until a turn of that chat shows a rewritten request:
an agent that sends to a host or in a format the gateway does not know is sent as written.

## Limits

- Detection is not perfect. A name the service misses is sent as written, unless the same name
  was caught earlier in the conversation. Check **Settings → Privacy** when the material matters.
- Details that are not identifiers on their own, such as a plot number, a district or a date, are
  not masked, and together they can point to a person.
- An agent can print a file in a form that is not plain text. Characters printed apart, as a
  character dump or a command that spaces out each letter shows them, are read put back together
  and masked. Other forms, such as hexadecimal or base64, are sent as they are.
- The model's own reasoning is shown with stand-ins, not real values.
- Sealing limits what a sealed file's answers reveal; it does not make them reveal nothing. An
  agent that asks many yes-or-no questions about one file learns a little with each, up to the
  file's limit. The agent is told to ask no more than the work needs.
- A yes-or-no answer and a choice from a list reach the model as they are. What the agent asks
  that way, such as whether a patient has a named allergy, is disclosed. Numbers, dates, names
  and reference numbers are not.
- A sealed file is only as private as the worker that reads it. With DoeDesk Cloud's worker,
  the file's text goes through DoeDesk Cloud to the company that runs the model for your
  region; what each of them keeps is in the Privacy Policy. With your own server, if it is not
  a server you control, the file leaves your control when it is read.
- Questions that need a reading of the whole file, such as "which of these proposals is the
  strongest", are answered less well from typed answers than by a model that reads the file.
- Turning masking off sends everything as written. DoeDesk says so in **Settings → Privacy**.
