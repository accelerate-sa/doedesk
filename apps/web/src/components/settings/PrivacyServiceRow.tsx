import type {
  PrivacyProviderHealth,
  PrivacyProviderRequest,
  PrivacyProviders,
  PrivacyService,
} from "@t3tools/contracts";
import { serverSentence } from "@t3tools/shared/serverSentencesCopy";
import { useGT, useMessages } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  PlugZapIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { configurePrivacyProvider, testPrivacyProvider } from "~/privacy/privacyClient";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PrivacyProviderFields } from "./PrivacyProviderFields";
import {
  DOEDESK_CLOUD,
  draftOf,
  fieldGroups,
  healthLabel,
  isDirty,
  missingField,
  providerCaution,
  type ProviderDraft,
  providerName,
  requestOf,
  SERVICE_TITLES,
} from "./PrivacyProviders.logic";
import { SettingsRow } from "./settingsLayout";

interface Form {
  readonly provider: string;
  readonly draft: ProviderDraft;
  readonly removed: ReadonlySet<string>;
}

type Dot = "ok" | "failed" | "waiting" | "idle";

const DOT_CLASS: Readonly<Record<Dot, string>> = {
  ok: "bg-success",
  failed: "bg-destructive",
  waiting: "bg-warning",
  idle: "bg-muted-foreground/40",
};

/**
 * One of the three services: which provider it uses, whether that provider answers, and the
 * provider's own fields when it has any. Choosing here changes this service alone.
 */
export function PrivacyServiceRow({
  service,
  detail,
  ready,
  signedIn,
}: {
  readonly service: PrivacyService;
  readonly detail: PrivacyProviders[PrivacyService];
  /** False: DoeDesk Cloud is the choice and no signed-in account has it. */
  readonly ready: boolean;
  readonly signedIn: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const saved = detail.config;
  // Null while the form shows what is saved. Set from the first edit until it is saved or dropped.
  const [form, setForm] = useState<Form | null>(null);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [health, setHealth] = useState<PrivacyProviderHealth | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const entry =
    detail.catalog.find((candidate) => candidate.id === (form?.provider ?? saved.provider)) ??
    detail.catalog[0];
  if (entry === undefined) return null;
  const draft = form?.draft ?? draftOf(entry, saved);
  const removed = form?.removed ?? new Set<string>();
  const groups = fieldGroups(entry);
  const hasFields = entry.fields.length > 0;
  const expanded = hasFields && (open || form !== null);
  const missing = missingField(entry, draft, saved, removed) !== undefined;
  const dirty = isDirty(entry, draft, saved, removed);
  const waitingForAccount = entry.id === DOEDESK_CLOUD && !ready;
  const title = resolve(SERVICE_TITLES[service]);
  const caution = providerCaution(service, entry, resolve);

  const dot: Dot =
    health !== null ? (health.ok ? "ok" : "failed") : waitingForAccount ? "waiting" : "idle";
  const dotLabel =
    health !== null
      ? healthLabel(health, resolve)
      : waitingForAccount
        ? signedIn
          ? gt("Not included in this account")
          : gt("Sign in to use DoeDesk Cloud")
        : gt("Not tested yet");

  const edit = (change: Partial<Form>) => {
    setHealth(null);
    setProblem(null);
    setForm({ provider: entry.id, draft, removed, ...change });
  };

  const save = (request: PrivacyProviderRequest) => {
    setBusy("save");
    setProblem(null);
    void configurePrivacyProvider(request)
      .then((result) => {
        setHealth(result.health ?? null);
        if (result.ok) {
          setForm(null);
          setOpen(false);
          return;
        }
        setProblem(
          result.health !== undefined
            ? healthLabel(result.health, resolve)
            : result.message === null
              ? gt("Could not save.")
              : serverSentence(result.message, resolve),
        );
      })
      .catch(() => setProblem(gt("Could not save.")))
      .finally(() => setBusy(null));
  };

  const test = () => {
    setBusy("test");
    setProblem(null);
    void testPrivacyProvider(requestOf(service, entry, draft, removed))
      .then((result) => {
        setHealth(result);
        setProblem(result.ok ? null : healthLabel(result, resolve));
      })
      .catch(() => setProblem(gt("Could not test.")))
      .finally(() => setBusy(null));
  };

  const choose = (id: string) => {
    const next = detail.catalog.find((candidate) => candidate.id === id);
    if (next === undefined) return;
    setHealth(null);
    setProblem(null);
    if (id === saved.provider) {
      setForm(null);
      return;
    }
    if (next.fields.length === 0) {
      // Nothing to fill in, so the choice is the whole change.
      setForm(null);
      save({ service, provider: id });
      return;
    }
    setForm({ provider: id, draft: draftOf(next, saved), removed: new Set() });
  };

  return (
    <SettingsRow
      title={title}
      status={
        problem !== null ? (
          <span role="alert" className="text-destructive">
            {problem}
          </span>
        ) : caution !== null ? (
          <span className="text-warning-foreground">{caution}</span>
        ) : undefined
      }
      control={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={dotLabel}
                  className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[dot])}
                />
              }
            />
            <TooltipPopup side="top">{dotLabel}</TooltipPopup>
          </Tooltip>
          <Select
            value={entry.id}
            disabled={busy !== null}
            onValueChange={(value) => {
              if (value !== null) choose(value);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={title}
              className="min-w-0 flex-1 @min-[32rem]/settings-row:w-60 @min-[32rem]/settings-row:flex-none"
            >
              <SelectValue>
                <span className="truncate">{providerName(entry, resolve)}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {detail.catalog.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {providerName(candidate, resolve)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={gt("Test {service}", { service: title })}
                  disabled={busy !== null || missing || waitingForAccount || entry.id === "off"}
                  onClick={test}
                >
                  {busy === "test" ? <Spinner size="sm" /> : <PlugZapIcon />}
                </Button>
              }
            />
            <TooltipPopup side="top">
              {gt("Test", { $context: "check that a service answers" })}
            </TooltipPopup>
          </Tooltip>
          {/* Kept in place when there is nothing to set, so the three rows line up. */}
          <span className={hasFields ? undefined : "invisible"}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={gt("{service} settings", { service: title })}
                    aria-expanded={expanded}
                    aria-hidden={hasFields ? undefined : true}
                    tabIndex={hasFields ? undefined : -1}
                    disabled={!hasFields || form !== null}
                    onClick={() => setOpen(!open)}
                  >
                    <SlidersHorizontalIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">{gt("Settings")}</TooltipPopup>
            </Tooltip>
          </span>
        </>
      }
    >
      {expanded ? (
        <form
          className="mt-3 mb-2 grid gap-3 rounded-lg border border-border/60 bg-muted/30 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!missing && dirty) save(requestOf(service, entry, draft, removed));
          }}
        >
          <PrivacyProviderFields
            fields={groups.main}
            draft={draft}
            secretsSet={saved.provider === entry.id ? saved.secretsSet : {}}
            removed={removed}
            disabled={busy !== null}
            onChange={(name, value) => edit({ draft: { ...draft, [name]: value } })}
            onRemoveSecret={(name) => edit({ removed: new Set([...removed, name]) })}
          />
          {groups.more.length === 0 ? null : (
            <>
              <div className="flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-expanded={more}
                  onClick={() => setMore(!more)}
                >
                  {more ? <ChevronDownIcon /> : <ChevronRightIcon className="rtl:rotate-180" />}
                  {gt("More options")}
                </Button>
              </div>
              {more ? (
                <PrivacyProviderFields
                  fields={groups.more}
                  draft={draft}
                  secretsSet={saved.provider === entry.id ? saved.secretsSet : {}}
                  removed={removed}
                  disabled={busy !== null}
                  onChange={(name, value) => edit({ draft: { ...draft, [name]: value } })}
                  onRemoveSecret={(name) => edit({ removed: new Set([...removed, name]) })}
                />
              ) : null}
            </>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy !== null || missing || !dirty}>
              {busy === "save" ? gt("Checking…") : gt("Save")}
            </Button>
            {form === null ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  setForm(null);
                  setHealth(null);
                  setProblem(null);
                }}
              >
                {gt("Cancel")}
              </Button>
            )}
            {entry.docsUrl === undefined ? null : (
              <span className="ms-auto">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={gt("Documentation")}
                        render={<a href={entry.docsUrl} target="_blank" rel="noreferrer" />}
                      >
                        <ExternalLinkIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">{gt("Documentation")}</TooltipPopup>
                </Tooltip>
              </span>
            )}
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}
