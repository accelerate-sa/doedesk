import type { PrivacyProviderField } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { XIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fieldLabel, type ProviderDraft } from "./PrivacyProviders.logic";

/** The empty choice of an optional list: the service's own default. */
const UNSET = "";
/** The shape of an HTTP header, which is the same in every language. */
const HEADER_EXAMPLE = "X-Header: value";

/**
 * A provider's fields as the server describes them. Nothing here knows a vendor: a new provider
 * on the server shows up with no change to this file.
 */
export function PrivacyProviderFields({
  fields,
  draft,
  secretsSet,
  removed,
  disabled,
  onChange,
  onRemoveSecret,
}: {
  readonly fields: ReadonlyArray<PrivacyProviderField>;
  readonly draft: ProviderDraft;
  /** Which secrets are saved for this provider. Their values never reach the app. */
  readonly secretsSet: Readonly<Record<string, boolean>>;
  /** Saved secrets the person asked to remove. */
  readonly removed: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onChange: (name: string, value: string) => void;
  readonly onRemoveSecret: (name: string) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
      {fields.map((field) => (
        <ProviderField
          key={field.name}
          field={field}
          value={draft[field.name] ?? ""}
          saved={secretsSet[field.name] === true && !removed.has(field.name)}
          disabled={disabled}
          onChange={(value) => onChange(field.name, value)}
          onRemoveSecret={() => onRemoveSecret(field.name)}
        />
      ))}
    </div>
  );
}

function ProviderField({
  field,
  value,
  saved,
  disabled,
  onChange,
  onRemoveSecret,
}: {
  readonly field: PrivacyProviderField;
  readonly value: string;
  readonly saved: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onRemoveSecret: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const id = useId();
  const label = fieldLabel(field, resolve);
  const wide = field.input === "headers" || field.input === "url";
  return (
    <div className={wide ? "grid gap-1 sm:col-span-2" : "grid gap-1"}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
        {field.required ? (
          <span aria-hidden className="ps-0.5 text-destructive">
            *
          </span>
        ) : null}
      </label>
      {field.input === "select" ? (
        <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next ?? UNSET)}>
          <SelectTrigger id={id} size="sm" aria-label={label}>
            <SelectValue>
              {value === UNSET ? (
                <span className="text-muted-foreground">{gt("Default")}</span>
              ) : (
                <bdi dir="ltr">{value}</bdi>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {field.required ? null : <SelectItem value={UNSET}>{gt("Default")}</SelectItem>}
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                <bdi dir="ltr">{option}</bdi>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : field.input === "headers" ? (
        <Textarea
          id={id}
          dir="ltr"
          size="sm"
          rows={2}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-required={field.required}
          placeholder={
            saved ? gt("Saved", { $context: "a key is already stored" }) : HEADER_EXAMPLE
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.input === "secret" ? (
        <div className="flex items-center gap-1">
          <Input
            id={id}
            dir="ltr"
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-required={field.required}
            // The key itself never reaches the app: only that one is saved.
            placeholder={saved ? gt("Saved", { $context: "a key is already stored" }) : undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          {saved && !field.required ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={gt("Remove saved {label}", { label })}
                    onClick={onRemoveSecret}
                  >
                    <XIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">{gt("Remove saved {label}", { label })}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : (
        <Input
          id={id}
          dir="ltr"
          size="sm"
          type={field.input === "url" ? "url" : "text"}
          inputMode={field.input === "number" ? "decimal" : undefined}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-required={field.required}
          placeholder={field.placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
