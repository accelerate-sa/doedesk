import { useGT } from "gt-react";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { WorkerForm } from "./SealedWorker.logic";

const DRIVERS = [
  // oxlint-disable-next-line t3code/no-untranslated-copy -- the name of an API format
  { value: "chatCompletions", label: "Chat Completions" },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- the name of an API format
  { value: "responses", label: "Responses" },
] as const;

export const EMPTY_WORKER_FORM: WorkerForm = {
  kind: "custom",
  apiKey: "",
  baseUrl: "",
  model: "",
  driver: "chatCompletions",
  reasoningEffort: "",
};

/** The address, key and model of the person's own server: in Settings, and before a first seal. */
export function WorkerServerFields({
  form,
  onChange,
  disabled = false,
  showReasoningEffort = true,
}: {
  readonly form: WorkerForm;
  readonly onChange: (change: Partial<WorkerForm>) => void;
  readonly disabled?: boolean;
  /** Settings only: few servers need it, and the dialog before sealing stays short. */
  readonly showReasoningEffort?: boolean;
}) {
  const gt = useGT();
  return (
    <>
      <Input
        dir="ltr"
        type="url"
        placeholder="http://localhost:11434/v1"
        aria-label={gt("Server address")}
        disabled={disabled}
        value={form.baseUrl}
        onChange={(event) => onChange({ baseUrl: event.target.value })}
      />
      <Input
        dir="ltr"
        type="password"
        autoComplete="off"
        placeholder={gt("API key (optional)")}
        aria-label={gt("API key")}
        disabled={disabled}
        value={form.apiKey}
        onChange={(event) => onChange({ apiKey: event.target.value })}
      />
      <Input
        dir="ltr"
        placeholder={gt("Model")}
        aria-label={gt("Model")}
        disabled={disabled}
        value={form.model}
        onChange={(event) => onChange({ model: event.target.value })}
      />
      <div className="flex items-center gap-2">
        <Select
          value={form.driver}
          disabled={disabled}
          onValueChange={(value) => {
            if (value !== null) onChange({ driver: value as WorkerForm["driver"] });
          }}
        >
          <SelectTrigger aria-label={gt("Request format")} className="w-44" size="sm">
            <SelectValue>
              {DRIVERS.find((driver) => driver.value === form.driver)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {DRIVERS.map((driver) => (
              <SelectItem key={driver.value} value={driver.value}>
                {driver.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {showReasoningEffort ? (
          <Input
            dir="ltr"
            placeholder={gt("Reasoning effort (optional)")}
            aria-label={gt("Reasoning effort")}
            disabled={disabled}
            value={form.reasoningEffort}
            onChange={(event) => onChange({ reasoningEffort: event.target.value })}
          />
        ) : null}
      </div>
    </>
  );
}
