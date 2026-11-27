# Images sent redacted

Written 19 November 2026. Numbers are from that day, with the detection and reading engines that
DoeDesk Cloud used then.
Re-run the corpus after a change to the reader, the detector or `packages/privacy-gateway/src/redaction`.

## What it does

With masking on, an image in a request is sent as the image itself, with a black box over each
personal detail and the detail's stand-in written on the box in white. Before this, the model
never saw the image: it got the text read from it, masked. That behaviour is still there as a
setting, and it is what happens whenever an image cannot be redacted safely.

Settings, Privacy, "Images and documents":

| Setting                    | What the AI company receives                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Redacted image             | The picture with boxes, and a short text legend. Falls back to masked text                                            |
| Masked text only (default) | The text read from the image, masked. No pixel. The default until redacted images are measured on a larger unseen set |
| Do not send                | A note that an image was withheld. Nothing is read                                                                    |

It applies to every request format the gateway rewrites: Anthropic `image` blocks in messages and
inside tool results, OpenAI `input_image` (messages and tool outputs) and `image_url`, Gemini
inline data in either spelling and inside a function response. An image given by URL or file id
is withheld, as before.

## The risk this path has that the text path does not

Text the reader does not read never leaves on the text path. On this path it stays in the pixels.
So a miss by the reader, a misreading, or a box drawn a letter short is a leak. Every rule below
exists for that reason, and none of them removes the risk: see "What still leaks".

## The rules

Code: `packages/privacy-gateway/src/redaction/`. Each number is in `DEFAULT_REDACTION_POLICY`.

1. **Only pixels.** The file is opened as what its first bytes say it is, never as what the
   request calls it. EXIF orientation is applied, transparency is flattened onto white, only the
   first frame or page is taken, and the result is written again from the pixels. EXIF, GPS,
   thumbnails, XMP, colour profiles and PNG text chunks do not survive, and nothing can be read
   back through an alpha channel. SVG, PDF, text, BMP and damaged files are refused.
2. **Two sizes, one set of positions.** The reader sees the picture at up to 4000 pixels on its
   long side; the model gets it at up to 1568 pixels and 1.15 megapixels. Positions found in the
   first are scaled into the second.
3. **Boxes follow the reader's own outline of each word**: four corners, so a box is turned and
   skewed as the text is. Each is padded (6% of the line's height along the text, 25% across,
   plus 1 and 2 pixels), made at least as tall as its line, joined with its neighbours of the
   same value, and grown along the text to the nearest clear gap.
4. **Detection runs on text, and is mapped back to words.** The page is given to the same
   detector and vault as any text, twice: line by line, as any document is, and as one line, so
   that a value that wraps is one value. Lines the reader returns in an order or spacing that
   hides a value are given once more, rewritten: left-to-right runs on an Arabic page put back
   in order (the reader returns a spaced IBAN last group first), letter-spaced writing joined
   up, letters written one under another joined up, a word hyphenated across a line joined up.
   A word found in any version is covered.
5. **Stand-ins are the vault's.** A value gets the stand-in it has in text. Every part of a value
   that wraps or is split across cells carries the same one. Identifiers the vault already knows
   are found whatever the spacing.
6. **What cannot be read is covered.** A word the reader gives less than 0.6 confidence, a word
   less than 14 pixels high in the picture the reader saw, and text-like marks the reader
   returned no word for (letter-sized marks standing in a row or column) are covered and marked
   `?` or `[UNREADABLE]`. A letter-spaced run with any covered piece is covered whole.
7. **The picture is read again before it is sent.** The bytes that would be sent are read by the
   reader a second time, and the detector is run on what is visible. Two things can follow.
   Something shows that the first reading did not account for (a value outside every word read
   before, or beside a box): it is covered where it was found, every box is widened by 60%, and
   the result is read a third time; if something still shows, the image is not sent. Or the
   detector, seeing the page without the values already found, now flags a word it passed
   before: that word is covered too, and the image is sent without another reading, because it
   is the picture just read with black added.
8. **Labels.** The stand-in is written on the box when it fits at 14 pixels high or more. A
   smaller box gets a number, and the numbers are explained in a text block after the image,
   which also lists every stand-in written on a box. A box too small for a number is listed
   there without one. Labels are drawn from a fixed dot face that holds only capital letters,
   digits, brackets, underscore and `?`: a label cannot be made from what its box hides.
9. **When it cannot be done, the image is not sent.** A reader that is down, late, or answers
   without word positions; positions that do not match the text; a file that is not an image;
   a failed re-read: each ends with the masked text of the image and a line saying why, or, if
   the image cannot be read as text either, with the withheld note. Never with the image.

The same image is read once: its result is kept in memory and reused on every turn while the
vault marks the same words in it, so each turn sends the same bytes.

## Measured

Three sets of generated images with pixel-accurate ground truth (the evaluation repository,
`audit/redaction`), run with the real reader and detector. "Legible" means the value, or a telling
part of it, is in the text the reader returns for the sent image outside its boxes, or in the
text of a second, unrelated reader (Tesseract, English only).

| Set                                                                 | Images sent                                          | Sensitive values legible in a sent image | Sensitive ink outside boxes                      | Other text covered |
| ------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ | ------------------ |
| Main corpus, 119 files. The rules were set while looking at it      | 111 of 112 valid images; 7 of 7 broken files refused | 0 of 940                                 | 0.01% (129 of 879,060 pixels; 6 values have any) | 15%                |
| First unseen set, 35 images, as first run                           | 35 of 35                                             | **14 of 238 (5.9%)**                     | 6.4%                                             | 17%                |
| The same set after two rules were changed because of it             | 35 of 35                                             | 0 of 238                                 | 0.18% (a title beside a name)                    | 19%                |
| Second unseen set, 28 images, written after those changes, run once | 28 of 28                                             | 0 of 182                                 | 0 of 145,733 pixels                              | 17%                |

The first unseen run is the number to remember. All 14 were names the detector did not flag.
Two causes were this code's: the page was given to the detector as one line, and the detector
finds names in line-broken text that it misses in a single line; and a name the detector found
only on the re-read was discarded as a word already judged. Both are fixed (rules 4 and 7). The
third cause is the detector's own recall, which no rule here changes.

What that leaves as evidence for the rules as they are now: one unseen set of 28 images, 182
mentions, none legible. With none in 182, the rate could still be as high as about 1.6% (95%).

|                                                |                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Images withheld after redaction failed         | 1 of 175 valid images across the three sets (a strongly angled photo)   |
| Metadata, alpha, extra frames in what was sent | none in 174                                                             |
| Reader pages for a new image                   | 2 for 171 of 174, 3 for the rest. The text path uses 1                  |
| Time added for a new image                     | median 2.6 s, 90th percentile 3.3 s, with two reads of about 1.2 s each |
| Time added on later turns                      | none for the reader; the kept result is reused                          |

## What still leaks, or is not covered

- **A value the detector does not flag is not covered**, and what leaks is the exact pixels.
  This was 14 of 238 on the first unseen set. The re-read gives the detector a second look at
  the page with the found values gone, which caught the rest there; it will not always.
- **A confident misreading.** Print about 8 pixels high came back as "Falsal Al-Harbl" at 0.95
  confidence; no detector takes that for a name. Rule 6 covers print under 14 pixels for this
  reason. Above that height the same failure is possible and was not seen in the corpus.
- **Parts of letters.** Up to 0.18% of sensitive ink: a letter of an account's country code
  run into the previous word, the first stroke of an Arabic name, a title before a name.
- **Faces, ID photos, signatures, logos, drawings, maps.** Not covered automatically; users can draw manual de-identification regions over them in the De-identification Studio.
- **QR codes and barcodes.** Decoded locally (`packages/privacy-gateway/src/redaction/barcodes.ts`, `zxing-wasm`) on every image and rendered PDF page. Codes carrying personal/account identifiers, Saudi ZATCA TLV payloads, or document-verification links are covered automatically; benign codes are left open and reported so the user can override them in the Studio.
- **PDFs.** Rendered locally to page images (`packages/privacy-gateway/src/deidentify/pdfPages.ts`, `pdfjs-dist` + `@napi-rs/canvas`) instead of trusting PDF text layers, then run through the same OCR, barcode, and manual region pipeline and rebuilt into a scrubbed multi-page PDF.
- **Vertical writing in scripts other than upright Latin letters and digits** was not tested.

## PDFs

File de-identification renders each PDF page locally as a picture (`pdfPages.ts`) rather than extracting the PDF text layer—avoiding reversed Arabic glyph streams, missing AcroForm field values, and embedded stamps/signatures. Each page runs through the same OCR layout, local QR/barcode scan, and manual region canvas as images, and exports as a scrubbed multi-page PDF of images.

## The reading tool

`ocr_masked` is offered to agents by default and can be switched off in Settings, Privacy. It
takes the absolute path of an image or PDF and returns the text read from it with stand-ins,
through the same vault. It never returns unmasked text: if the text cannot be checked, it returns
an error. The server reads the file with the user's rights and asks nobody, so it reads only
where the agent could read without asking: inside the calling thread's workspace, or anywhere
for a thread in full access. Links are resolved before the check.

## What the user can download

Settings, Privacy, "What was sent in place of files" lists each recent image or document with
the redacted image, the masked text, or both. They are kept in `<state>/privacy/redactions/`
(folder 0700, files 0600), named by a hash of the original, for seven days or 200 records, and
can all be deleted from the same screen. The original file is never written there. This store is
new with this feature.

## What changed elsewhere

- DoeDesk Cloud: `POST /v1/ocr?layout=1` asks for `layout` (each word's corners, confidence and
  position in the text). Whenever a detection service returns no positions, the app sends masked
  text with a line saying the image could not be redacted. The text is the one that reading returned: the
  image is not read, or counted against the allowance, a second time.
- The server stages `sharp` (libvips) beside its other native packages. HEIC is opened with
  macOS `sips`; elsewhere a HEIC file is refused.

## Running the measurements

The live check with real provider sessions is `packages/privacy-gateway/scripts/redaction-live.ts`.
