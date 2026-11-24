const STAND_IN = /(\[[A-Z]+_[A-HJ-NP-Z2-9]{5}\])/u;

/**
 * What the AI company is told a sealed file is called, drawn left to right and free to wrap
 * anywhere except inside a stand-in: `[PERSON_K2M4P` on one line and `]` on the next reads as
 * two things.
 */
export function SentLabel({ label }: { readonly label: string }) {
  return (
    <bdi dir="ltr" className="font-mono wrap-anywhere">
      {label.split(STAND_IN).map((part, index) =>
        index % 2 === 1 ? (
          // The pieces keep their order: a label never changes while it is shown.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </bdi>
  );
}
