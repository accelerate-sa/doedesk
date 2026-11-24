import { standInKind, type KnownValueMatcher } from "@t3tools/shared/privacyKnownValues";
import { T, useMessages, Var } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Tooltip, TooltipPopup } from "../ui/tooltip";
import { standInKindLabel } from "./TurnPrivacy.logic";
import {
  startValueMarks,
  type ValueMarkHit,
  type ValueMarkStats,
  type ValueMarkSurface,
  type ValueMarkSurfaceOptions,
} from "./valueMarkRanges";

/** How long the pointer rests on a mark before its stand-in is shown. */
const HOVER_REST_MS = 200;

/**
 * What a mark says. `sent`: a chat turn that has ended, so what was sent is known. `sends`: an
 * open file, where it is what DoeDesk does whenever the value is sent.
 */
export type ValueMarkTense = "sent" | "sends";

/** The stand-ins behind one mark or one cell, each with its kind. */
export function ValueMarkTooltip({
  anchor,
  tokens,
  tense,
  onClose,
}: {
  readonly anchor: DOMRect;
  readonly tokens: ReadonlyArray<string>;
  readonly tense: ValueMarkTense;
  readonly onClose: () => void;
}) {
  const resolve = useMessages();
  return (
    <Tooltip open onOpenChange={(open) => (open ? undefined : onClose())}>
      <TooltipPopup anchor={{ getBoundingClientRect: () => anchor }} side="top">
        <ul className="flex flex-col gap-1 text-start" data-value-mark-tooltip>
          {tokens.map((token) => (
            <li key={token}>
              <p>
                {tense === "sent" ? (
                  <T>
                    Sent to the AI as{" "}
                    <code dir="ltr" className="font-mono">
                      <Var>{token}</Var>
                    </code>
                  </T>
                ) : (
                  <T>
                    DoeDesk sends{" "}
                    <code dir="ltr" className="font-mono">
                      <Var>{token}</Var>
                    </code>{" "}
                    in its place
                  </T>
                )}
              </p>
              <p className="text-muted-foreground">
                {resolve(standInKindLabel(standInKind(token)))}
              </p>
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Marks the known values in `host`'s text and shows a mark's stand-in while the pointer rests on
 * it, or when it is tapped. Renders nothing but that tooltip.
 */
export function ValueMarks({
  host,
  shadow,
  highlight,
  unitSelector,
  scopeSelector,
  unitAttributes,
  lineBreaks,
  matcherFor,
  revision,
  tense,
  onStats,
}: Pick<
  ValueMarkSurfaceOptions,
  "shadow" | "highlight" | "unitSelector" | "scopeSelector" | "unitAttributes" | "lineBreaks"
> & {
  readonly host: Element | null;
  readonly matcherFor: (unit: Element) => KnownValueMatcher | null;
  /** Any value that changes when `matcherFor` may answer differently. */
  readonly revision: unknown;
  readonly tense: ValueMarkTense;
  readonly onStats?: (stats: ValueMarkStats) => void;
}) {
  const [hit, setHit] = useState<ValueMarkHit | null>(null);
  const surfaceRef = useRef<ValueMarkSurface | null>(null);
  /** The mark whose tooltip is up, so resting on it again does not restart it. */
  const shownRef = useRef<string | null>(null);
  const readMatcher = useEffectEvent(matcherFor);
  const reportStats = useEffectEvent((stats: ValueMarkStats) => onStats?.(stats));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS highlights over the host's text, follows its mutations and pointer, and removes them on cleanup
  useEffect(() => {
    if (host === null) return;
    const surface = startValueMarks({
      host,
      highlight,
      unitSelector,
      matcherFor: readMatcher,
      onStats: reportStats,
      ...(shadow === undefined ? {} : { shadow }),
      ...(scopeSelector === undefined ? {} : { scopeSelector }),
      ...(unitAttributes === undefined ? {} : { unitAttributes }),
      ...(lineBreaks === undefined ? {} : { lineBreaks }),
    });
    surfaceRef.current = surface;
    let frame = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    let pointer: { x: number; y: number } | null = null;
    const keyOf = (next: ValueMarkHit) => `${next.token}:${next.rect.left}:${next.rect.top}`;
    const hide = () => {
      clearTimeout(rest);
      rest = undefined;
      if (shownRef.current === null) return;
      shownRef.current = null;
      setHit(null);
    };
    const show = (next: ValueMarkHit) => {
      shownRef.current = keyOf(next);
      setHit(next);
    };
    const look = () => {
      frame = 0;
      const next = pointer === null ? null : surface.at(pointer.x, pointer.y);
      if (next === null) {
        hide();
        return;
      }
      if (shownRef.current === keyOf(next)) return;
      clearTimeout(rest);
      rest = setTimeout(() => show(next), HOVER_REST_MS);
    };
    const move = (event: Event) => {
      const { clientX, clientY } = event as PointerEvent;
      pointer = { x: clientX, y: clientY };
      if (frame === 0) frame = requestAnimationFrame(look);
    };
    const leave = () => {
      pointer = null;
      hide();
    };
    // A tap has no hover. Selecting text and following a link go on as before.
    const tap = (event: Event) => {
      const { clientX, clientY } = event as MouseEvent;
      const next = surface.at(clientX, clientY);
      if (next === null) hide();
      else {
        clearTimeout(rest);
        show(next);
      }
    };
    host.addEventListener("pointermove", move, { passive: true });
    host.addEventListener("pointerleave", leave);
    host.addEventListener("click", tap);
    host.addEventListener("scroll", leave, { capture: true, passive: true });
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("click", tap);
      host.removeEventListener("scroll", leave, { capture: true });
      if (frame !== 0) cancelAnimationFrame(frame);
      clearTimeout(rest);
      surfaceRef.current = null;
      surface.stop();
      hide();
    };
  }, [host, shadow, highlight, unitSelector, scopeSelector, unitAttributes, lineBreaks]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- looks again in the host's DOM when the values to mark change
  useEffect(() => {
    surfaceRef.current?.refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The revision is the signal: a new one means the values changed.
  }, [revision]);

  return hit === null ? null : (
    <ValueMarkTooltip
      anchor={hit.rect}
      tokens={[hit.token]}
      tense={tense}
      onClose={() => {
        shownRef.current = null;
        setHit(null);
      }}
    />
  );
}
