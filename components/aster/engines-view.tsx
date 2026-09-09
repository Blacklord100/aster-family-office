'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  Cloud,
  Cpu,
  FlaskConical,
  GitBranch,
  KeyRound,
  Loader2,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Skeleton } from '@/components/ui/skeleton';
import { EngineInputSchema } from '@/lib/engine-contract';
import {
  EngineInspectionSchema,
  inspectionIdentity,
  inspectionMatches,
  type EngineInspection,
} from '@/lib/engine-inspection';
import { EngineInspectionDetails } from './engine-inspection';
import type {
  EngineModel,
  EngineModelsResponse,
  EngineProfile,
  EngineProvider,
  EngineSnapshot,
  EnginesResponse,
} from '@/lib/engine-contract';
import type {
  ProcessingPolicy,
  ProcessingMode,
} from '@/lib/processing-contract';
import { PageHeading, Panel, Picker, Status } from './primitives';
import styles from './engines.module.css';

const providerName: Record<EngineProvider, string> = {
  ollama: 'Ollama · local',
  openai: 'OpenAI',
  anthropic: 'Anthropic · Claude',
};
type Draft = {
  id: string | null;
  revision: number;
  name: string;
  provider: EngineProvider;
  model: string;
  apiKey: string;
  hasSecret: boolean;
};
const emptyDraft = (): Draft => ({
  id: null,
  revision: 0,
  name: '',
  provider: 'ollama',
  model: '',
  apiKey: '',
  hasSecret: false,
});
async function api<T>(
  url: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(payload?.message ?? 'The request could not be completed.');
  return payload as T;
}

export function EnginesView() {
  const [snapshot, setSnapshot] = useState<EnginesResponse | null>(null);
  const [policy, setPolicy] = useState<ProcessingPolicy | null>(null);
  const [models, setModels] = useState<EngineModel[]>([]);
  const [discovered, setDiscovered] = useState(false);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [activate, setActivate] = useState<EngineProfile | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [inspection, setInspection] = useState<EngineInspection | null>(null);
  const inspectionRequest = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const [engines, processing] = await Promise.all([
      api<EnginesResponse>('/api/engines'),
      api<{ policy: ProcessingPolicy }>('/api/processing'),
    ]);
    setSnapshot(engines);
    setInspection(null);
    setPolicy(processing.policy);
    setLoadedAt(
      new Date().toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    setActivate(null);
    setRemove(null);
    setAcknowledged(false);
    setDraft((current) => ({ ...current, apiKey: '' }));
  }, []);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<EnginesResponse>('/api/engines'),
      api<{ policy: ProcessingPolicy }>('/api/processing'),
    ])
      .then(([engines, processing]) => {
        if (!cancelled) {
          setSnapshot(engines);
          setPolicy(processing.policy);
          setLoadedAt(
            new Date().toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
            }),
          );
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Could not load engines.');
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
      inspectionRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (editing) nameInput.current?.focus();
  }, [editing, draft.id]);
  async function action(id: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'The change could not be completed.',
      );
    } finally {
      setBusy(null);
    }
  }
  async function discover() {
    await action('discover', async () => {
      const result = await api<EngineModelsResponse>('/api/engines/models');
      setModels(result.models);
      setDiscovered(true);
      setNotice(
        `Found ${result.models.length} installed models. No model was downloaded or activated.`,
      );
    });
  }
  async function inspectRuntime(
    engine: EngineSnapshot,
    target: 'active' | 'profile',
  ) {
    await action('inspect:' + inspectionIdentity(engine), async () => {
      setInspection(null);
      const controller = new AbortController();
      inspectionRequest.current = controller;
      try {
        const result = EngineInspectionSchema.parse(
          await api(
            '/api/engines/inspect',
            'POST',
            {
              target,
              profileId: engine.profileId,
              revision: engine.revision,
            },
            controller.signal,
          ),
        );
        if (result.target !== target || !inspectionMatches(result, engine))
          throw new Error('Engine changed. Refresh and inspect again.');
        setInspection(result);
      } finally {
        if (inspectionRequest.current === controller)
          inspectionRequest.current = null;
      }
    });
  }
  function edit(profile?: EngineProfile) {
    setDraft(
      profile
        ? {
            id: profile.profileId,
            revision: profile.revision,
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
            apiKey: '',
            hasSecret: profile.hasSecret,
          }
        : emptyDraft(),
    );
    setEditing(true);
    setError(null);
    setNotice(null);
    setActivate(null);
    setRemove(null);
    setAcknowledged(false);
    setFieldErrors({});
  }
  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot?.canManage || busy) return;
    const parsed = EngineInputSchema.safeParse({
      name: draft.name.trim(),
      provider: draft.provider,
      model: draft.model.trim(),
      ...(draft.provider !== 'ollama' && draft.apiKey
        ? { apiKey: draft.apiKey }
        : {}),
    });
    const errors: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        errors[field] =
          field === 'name'
            ? 'Enter a profile name of 1–80 characters.'
            : field === 'model'
              ? 'Enter an exact model ID using letters, numbers, dots, colons, slashes, underscores or hyphens.'
              : field === 'apiKey'
                ? 'Use a 16–4096 character API key with no spaces or non-ASCII characters.'
                : 'Choose a supported provider.';
      }
    if (draft.provider !== 'ollama' && !draft.hasSecret && !draft.apiKey)
      errors.apiKey = 'Enter an API key for this provider.';
    const currentProfile = snapshot.profiles.find(
      (profile) => profile.profileId === draft.id,
    );
    if (
      draft.id &&
      (!currentProfile || currentProfile.revision !== draft.revision)
    ) {
      setError(
        'This profile changed while you were editing. Open the latest revision before saving.',
      );
      setDraft((current) => ({ ...current, apiKey: '' }));
      return;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      document
        .getElementById(
          'engine-' +
            (Object.keys(errors)[0] === 'apiKey'
              ? 'key'
              : Object.keys(errors)[0]),
        )
        ?.focus();
      setDraft((current) => ({ ...current, apiKey: '' }));
      return;
    }
    await action('save', async () => {
      try {
        const body = {
          name: draft.name.trim(),
          provider: draft.provider,
          model: draft.model.trim(),
          ...(draft.provider !== 'ollama' && draft.apiKey
            ? { apiKey: draft.apiKey }
            : {}),
          ...(draft.id ? { revision: draft.revision } : {}),
        };
        await api(
          draft.id ? `/api/engines/${draft.id}` : '/api/engines',
          draft.id ? 'PATCH' : 'POST',
          body,
        );
        setEditing(false);
        setDraft(emptyDraft());
        await load();
        setNotice(
          'Engine profile saved. Activate it explicitly when you want new jobs to use it.',
        );
      } finally {
        setDraft((current) => ({ ...current, apiKey: '' }));
      }
    });
  }
  async function changeMode(mode: ProcessingMode) {
    if (!snapshot?.canManage || mode === policy?.mode) return;
    await action('mode', async () => {
      const next = await api<ProcessingPolicy>('/api/processing', 'PATCH', {
        mode,
      });
      setPolicy(next);
      setNotice(
        'Workflow preference saved for new jobs. Existing jobs keep their original mode and engine.',
      );
    });
  }
  async function activateProfile(profile: EngineProfile) {
    if (!snapshot?.canManage) return;
    await action('activate:' + profile.profileId, async () => {
      await api(`/api/engines/${profile.profileId}/activate`, 'POST', {
        revision: profile.revision,
        acknowledgeCloudEgress: profile.execution === 'cloud' && acknowledged,
      });
      setActivate(null);
      setAcknowledged(false);
      await load();
      setNotice(
        `${profile.name} is now selected for new jobs. Existing jobs keep their original engine.`,
      );
    });
  }
  const active = snapshot?.active;
  const inspectedEngine =
    inspection?.target === 'active'
      ? active
      : snapshot?.profiles.find(
          (profile) => profile.profileId === inspection?.profileId,
        );
  const visibleInspection =
    inspection &&
    inspectedEngine &&
    inspectionMatches(inspection, inspectedEngine)
      ? inspection
      : null;
  const canManage = snapshot?.canManage ?? false;
  const latestDraftProfile = snapshot?.profiles.find(
    (profile) => profile.profileId === draft.id,
  );
  const draftIsStale = Boolean(
    draft.id &&
    (!latestDraftProfile || latestDraftProfile.revision !== draft.revision),
  );
  return (
    <div className={styles.page}>
      <PageHeading
        title="Your intelligence, your choice."
        subtitle="Choose where AI runs and how it works. Keep one evidence and review standard."
      >
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={() => void action('refresh', load)}
        >
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
        {canManage && (
          <Button disabled={!!busy} onClick={() => edit()}>
            <Plus data-icon="inline-start" />
            Add engine
          </Button>
        )}
      </PageHeading>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Action unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <Check />
          <AlertDescription>
            <output>{notice}</output>
          </AlertDescription>
        </Alert>
      )}
      {!snapshot && !error && (
        <div className={styles.loading}>
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      )}
      {snapshot && active && (
        <>
          <p className={styles.snapshotNote}>
            {loadedAt ? `Last refreshed ${loadedAt}. ` : ''}
            Refresh to see changes made elsewhere.
            {!canManage
              ? ' A workspace administrator can change engines and execution style.'
              : ''}
          </p>
          <section className={styles.active} aria-label="Active engine">
            <div className={styles.activeIntro}>
              <div className={styles.eyebrow}>
                <span className={styles.liveDot} />
                SELECTED FOR NEW JOBS
              </div>
              <h2>{active.name}</h2>
              <p>{active.model}</p>
              <div className={styles.badges}>
                <Status
                  tone={active.execution === 'local' ? 'success' : 'warning'}
                >
                  {active.execution === 'local' ? <LockKeyhole /> : <Cloud />}
                  {active.execution === 'local'
                    ? 'Local inference'
                    : 'Cloud inference'}
                </Status>
                <Badge variant="outline">{providerName[active.provider]}</Badge>
                <Badge variant="outline">Revision {active.revision}</Badge>
              </div>
            </div>
            <dl className={styles.activeFacts}>
              <div>
                <dt>Execution</dt>
                <dd>
                  {policy?.mode === 'agentic'
                    ? 'Bounded agent'
                    : 'Classical workflow'}
                </dd>
              </div>
              <div>
                <dt>Provider fallback</dt>
                <dd>Never automatic</dd>
              </div>
              <div>
                <dt>Financial updates</dt>
                <dd>Human review required</dd>
              </div>
            </dl>
          </section>
          <Panel
            title="Runtime capabilities & limits"
            subtitle="An explicit metadata check for a selected engine revision."
          >
            <div className={styles.panelBody}>
              <div className={styles.inspectionHeading}>
                <p>
                  Inspect local model metadata and effective processor limits.
                  This check does not generate text, test images or contact a
                  cloud model provider.
                </p>
                {canManage && (
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void inspectRuntime(active, 'active')}
                  >
                    <Cpu data-icon="inline-start" />
                    {busy?.startsWith('inspect:')
                      ? 'Inspecting…'
                      : 'Inspect selected runtime'}
                  </Button>
                )}
              </div>
              {visibleInspection && inspectedEngine ? (
                <div
                  key={
                    visibleInspection.target +
                    inspectionIdentity(visibleInspection) +
                    visibleInspection.checkedAt
                  }
                >
                  <h3>
                    {inspectedEngine.name} · revision{' '}
                    {visibleInspection.revision}
                  </h3>
                  <p className={styles.digest}>{visibleInspection.model}</p>
                  <EngineInspectionDetails inspection={visibleInspection} />
                </div>
              ) : (
                <p>
                  {canManage
                    ? 'No current metadata inspection. Choose an engine to inspect.'
                    : 'A workspace administrator can inspect runtime metadata.'}
                </p>
              )}
            </div>
          </Panel>
          <div className={styles.grid}>
            <Panel
              title="01 / Execution style"
              subtitle="Independent of the model you choose."
            >
              <div className={styles.panelBody}>
                <ToggleGroup
                  multiple={false}
                  variant="outline"
                  value={policy ? [policy.mode] : []}
                  onValueChange={(values) => {
                    if (values[0]) void changeMode(values[0] as ProcessingMode);
                  }}
                  disabled={!canManage || !!busy}
                  aria-label="Execution style"
                  className={styles.modeToggle}
                >
                  <ToggleGroupItem value="workflow">
                    <GitBranch data-icon="inline-start" />
                    Classical workflow
                  </ToggleGroupItem>
                  <ToggleGroupItem value="agentic">
                    <Bot data-icon="inline-start" />
                    Bounded agent
                  </ToggleGroupItem>
                </ToggleGroup>
                <h3>
                  {policy?.mode === 'agentic'
                    ? 'The model selects the next extraction step.'
                    : 'A fixed sequence reads each document.'}
                </h3>
                <p>
                  {policy?.mode === 'agentic'
                    ? 'A structured planner works within allowed document tools and step limits. Compatible local models, including Gemma and Qwen, can use this same agent loop.'
                    : 'Classification, parsing and validation run in a fixed order. The selected model can help extract unresolved fields.'}
                </p>
                <div className={styles.rule}>
                  <ShieldCheck />
                  <span>
                    Both modes validate facts against document evidence. Model
                    choice and workflow do not guarantee identical extraction
                    accuracy.
                  </span>
                </div>
              </div>
            </Panel>
            <Panel
              title="02 / Data boundary"
              subtitle="A deliberate choice for every workspace."
            >
              <div className={styles.panelBody}>
                <div className={styles.boundary}>
                  <div>
                    <Cpu />
                    <strong>Local models</strong>
                    <span>Configured private runtime</span>
                  </div>
                  <div>
                    <Cloud />
                    <strong>Cloud models</strong>
                    <span>Selected external provider</span>
                  </div>
                </div>
                <p>
                  {active.execution === 'local'
                    ? 'Document inference uses the deployment’s local processor and Ollama endpoint. Local model selection is separate from wider hosting, mailbox and access-control settings.'
                    : 'Document content is sent to the selected cloud processor and model provider. The provider’s account terms and retention settings apply.'}
                </p>
                <div className={styles.rule}>
                  <KeyRound />
                  <span>
                    {snapshot.cloudAllowed
                      ? 'Cloud execution is enabled by this deployment. Activation requires an administrator’s explicit acknowledgment.'
                      : 'Cloud execution is disabled by this deployment. An operator must configure a separate cloud processor before activation.'}
                    {!snapshot.cloudAllowed &&
                    snapshot.cloudReadinessReason &&
                    snapshot.cloudReadinessReason !==
                      'Cloud execution disabled by deployment.'
                      ? ` ${snapshot.cloudReadinessReason}`
                      : ''}
                  </span>
                </div>
              </div>
            </Panel>
          </div>

          {editing && canManage && (
            <Panel
              title={draft.id ? 'Edit engine profile' : 'Add an engine'}
              subtitle="Saving a profile does not change the active engine."
            >
              <form
                className={styles.editor}
                onSubmit={(event) => void save(event)}
                autoComplete="off"
                noValidate
              >
                {draftIsStale ? (
                  <Alert>
                    <AlertTitle>This profile has changed</AlertTitle>
                    <AlertDescription>
                      {latestDraftProfile
                        ? `Revision ${latestDraftProfile.revision} is now available. Reopen it before saving.`
                        : 'This profile was removed. Cancel this edit to create a new profile.'}
                      {latestDraftProfile ? (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={!!busy}
                          onClick={() => edit(latestDraftProfile)}
                        >
                          Open latest revision
                        </Button>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <FieldSet disabled={!!busy}>
                  <FieldGroup>
                    <Field data-invalid={Boolean(fieldErrors.name)}>
                      <FieldLabel htmlFor="engine-name">
                        Profile name
                      </FieldLabel>
                      <Input
                        id="engine-name"
                        ref={nameInput}
                        aria-invalid={Boolean(fieldErrors.name)}
                        aria-describedby={
                          fieldErrors.name ? 'engine-name-error' : undefined
                        }
                        value={draft.name}
                        maxLength={80}
                        required
                        placeholder="Private research · Gemma"
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                      />
                      {fieldErrors.name ? (
                        <FieldError id="engine-name-error">
                          {fieldErrors.name}
                        </FieldError>
                      ) : null}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="engine-provider">
                        Provider
                      </FieldLabel>
                      <Picker
                        id="engine-provider"
                        label="Engine provider"
                        value={draft.provider}
                        onChange={(value) => {
                          const original = snapshot.profiles.find(
                            (profile) => profile.profileId === draft.id,
                          );
                          setDraft({
                            ...draft,
                            provider: value as EngineProvider,
                            model:
                              original?.provider === value
                                ? original.model
                                : '',
                            apiKey: '',
                            hasSecret:
                              original?.provider === value &&
                              original.hasSecret,
                          });
                          setFieldErrors({});
                        }}
                        options={Object.entries(providerName).map(
                          ([value, label]) => ({ value, label }),
                        )}
                      />
                    </Field>
                    {draft.provider === 'ollama' && models.length > 0 && (
                      <Field>
                        <FieldLabel htmlFor="installed-model">
                          Installed model
                        </FieldLabel>
                        <Picker
                          id="installed-model"
                          label="Installed model"
                          value={
                            models.some((model) => model.name === draft.model)
                              ? draft.model
                              : ''
                          }
                          onChange={(model) => setDraft({ ...draft, model })}
                          options={[
                            { value: '', label: 'Choose an installed model' },
                            ...models.map((model) => ({
                              value: model.name,
                              label: model.name,
                            })),
                          ]}
                        />
                      </Field>
                    )}
                    <Field data-invalid={Boolean(fieldErrors.model)}>
                      <FieldLabel htmlFor="engine-model">
                        Exact model ID
                      </FieldLabel>
                      <Input
                        id="engine-model"
                        aria-invalid={Boolean(fieldErrors.model)}
                        aria-describedby={
                          fieldErrors.model ? 'engine-model-error' : undefined
                        }
                        value={draft.model}
                        maxLength={121}
                        required
                        placeholder={
                          draft.provider === 'ollama'
                            ? 'gemma4:e4b-m3'
                            : 'Model ID supported by your API account'
                        }
                        onChange={(event) =>
                          setDraft({ ...draft, model: event.target.value })
                        }
                      />
                      {fieldErrors.model ? (
                        <FieldError id="engine-model-error">
                          {fieldErrors.model}
                        </FieldError>
                      ) : null}
                      <FieldDescription>
                        {draft.provider === 'ollama'
                          ? 'Use a model already installed on your Ollama runtime. Aster never downloads one automatically.'
                          : draft.provider === 'openai'
                            ? 'Uses the OpenAI Responses API, including compatible Codex model IDs. Requires an API key; a ChatGPT or Codex subscription is not an API credential.'
                            : 'Uses the Anthropic Messages API. Choose a Claude model that supports the structured output contract.'}
                      </FieldDescription>
                    </Field>
                    {draft.provider !== 'ollama' && (
                      <Field data-invalid={Boolean(fieldErrors.apiKey)}>
                        <FieldLabel htmlFor="engine-key">
                          API key{' '}
                          {draft.hasSecret ? '(optional replacement)' : ''}
                        </FieldLabel>
                        <Input
                          id="engine-key"
                          aria-invalid={Boolean(fieldErrors.apiKey)}
                          aria-describedby={
                            fieldErrors.apiKey ? 'engine-key-error' : undefined
                          }
                          type="password"
                          value={draft.apiKey}
                          minLength={16}
                          maxLength={4096}
                          required={!draft.hasSecret}
                          autoComplete="new-password"
                          spellCheck={false}
                          onChange={(event) =>
                            setDraft({ ...draft, apiKey: event.target.value })
                          }
                        />
                        {fieldErrors.apiKey ? (
                          <FieldError id="engine-key-error">
                            {fieldErrors.apiKey}
                          </FieldError>
                        ) : null}
                        <FieldDescription>
                          {draft.hasSecret
                            ? 'A key is configured. Leave blank to keep it.'
                            : 'Stored encrypted on the server. The saved key is never returned to this panel.'}{' '}
                          The entered key is cleared from this form after every
                          save attempt, refresh or provider change.
                        </FieldDescription>
                      </Field>
                    )}
                  </FieldGroup>
                </FieldSet>
                {draft.provider !== 'ollama' && (
                  <Alert>
                    <Cloud />
                    <AlertDescription>
                      Activating a cloud engine sends document content to that
                      provider. Saving a profile alone sends no documents.
                    </AlertDescription>
                  </Alert>
                )}
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => {
                      setEditing(false);
                      setDraft(emptyDraft());
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!!busy || draftIsStale}>
                    {busy === 'save' && (
                      <Loader2
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    )}
                    Save profile
                  </Button>
                </div>
              </form>
            </Panel>
          )}

          <Panel
            title="Engine library"
            subtitle="Profiles are versioned. Queued jobs retain the model and workflow selected when they were created."
            action={
              <Badge variant="secondary">
                {snapshot.profiles.length}{' '}
                {snapshot.profiles.length === 1 ? 'profile' : 'profiles'}
              </Badge>
            }
          >
            <div className={styles.library}>
              <div className={styles.defaultRow}>
                <div>
                  <strong>Deployment default</strong>
                  <p>
                    The operator’s configured local model. Used until this
                    workspace selects a profile.
                  </p>
                </div>
                {active.profileId === null ? (
                  <Status tone="success">Selected</Status>
                ) : (
                  canManage && (
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() =>
                        void action('default', async () => {
                          await api(
                            '/api/engines/default/activate',
                            'POST',
                            {},
                          );
                          await load();
                          setNotice(
                            'Deployment default restored for new jobs.',
                          );
                        })
                      }
                    >
                      Use default
                    </Button>
                  )
                )}
              </div>
              {snapshot.profiles.map((profile) => {
                const selected =
                  active.profileId === profile.profileId &&
                  active.revision === profile.revision;
                const olderRevisionActive =
                  active.profileId === profile.profileId && !selected;
                const cloudUnavailable =
                  profile.execution === 'cloud' &&
                  (!snapshot.cloudAllowed || !profile.hasSecret);
                return (
                  <article
                    className={styles.profile}
                    key={profile.profileId}
                    aria-label={profile.name}
                  >
                    <div className={styles.profileHead}>
                      <div className={styles.profileIcon}>
                        {profile.execution === 'local' ? <Cpu /> : <Cloud />}
                      </div>
                      <div>
                        <h3>{profile.name}</h3>
                        <p>{profile.model}</p>
                      </div>
                      <Status tone={selected ? 'success' : 'neutral'}>
                        {selected ? 'Selected' : `Revision ${profile.revision}`}
                      </Status>
                    </div>
                    {olderRevisionActive ? (
                      <p className={styles.revisionNote}>
                        Revision {active.revision} is still selected for new
                        jobs. Saved revision {profile.revision} takes effect
                        only after you activate it.
                      </p>
                    ) : null}
                    <div className={styles.profileMeta}>
                      <span>{providerName[profile.provider]}</span>
                      <span>
                        {profile.execution === 'local'
                          ? 'Local inference'
                          : profile.hasSecret
                            ? 'API key configured'
                            : 'API key missing'}
                      </span>
                      <span>
                        {profile.lastTest
                          ? `${profile.lastTest.ok ? 'Text connectivity/schema check passed' : 'Text check failed'} · ${new Date(profile.lastTest.testedAt).toLocaleDateString('en-GB')}`
                          : 'Not tested'}
                      </span>
                    </div>
                    {profile.lastTest && !profile.lastTest.ok && (
                      <p className={styles.failure}>
                        Last check:{' '}
                        {profile.lastTest.errorCode ?? 'Unavailable'}. Check the
                        model, credential and deployment connection.
                      </p>
                    )}
                    {canManage && (
                      <div className={styles.actions}>
                        <Button
                          variant="outline"
                          disabled={!!busy || cloudUnavailable}
                          onClick={() =>
                            void action(
                              'test:' + profile.profileId,
                              async () => {
                                try {
                                  await api(
                                    `/api/engines/${profile.profileId}/test`,
                                    'POST',
                                    { revision: profile.revision },
                                  );
                                } finally {
                                  await load();
                                }
                                setNotice(
                                  'Synthetic text connectivity/schema check finished. It does not test images or measure extraction accuracy.',
                                );
                              },
                            )
                          }
                        >
                          <FlaskConical data-icon="inline-start" />
                          {busy === 'test:' + profile.profileId
                            ? 'Testing…'
                            : 'Test text connection'}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={!!busy || cloudUnavailable}
                          onClick={() =>
                            void inspectRuntime(profile, 'profile')
                          }
                        >
                          <Cpu data-icon="inline-start" />
                          Inspect metadata
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() => edit(profile)}
                        >
                          <Pencil data-icon="inline-start" />
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Remove ${profile.name}`}
                          disabled={
                            !!busy || active.profileId === profile.profileId
                          }
                          onClick={() => {
                            setRemove(profile.profileId);
                            setActivate(null);
                            setAcknowledged(false);
                          }}
                        >
                          <Trash2 />
                        </Button>
                        <Button
                          disabled={!!busy || selected || cloudUnavailable}
                          onClick={() => {
                            setActivate(profile);
                            setAcknowledged(false);
                            setRemove(null);
                          }}
                        >
                          {selected ? 'Selected' : 'Use for new jobs'}
                          <ArrowRight data-icon="inline-end" />
                        </Button>
                      </div>
                    )}
                    {canManage &&
                      activate?.profileId === profile.profileId &&
                      activate.revision === profile.revision && (
                        <Alert className={styles.confirm}>
                          <AlertTitle>
                            Use {profile.name}, revision {profile.revision}, for
                            new jobs?
                          </AlertTitle>
                          <AlertDescription>
                            <p>
                              {profile.execution === 'cloud'
                                ? 'Future document content will leave your local inference environment and be sent to this provider. Provider terms and retention settings apply.'
                                : 'New uploads and mailbox jobs will use this local model. Existing jobs retain their pinned engine.'}
                            </p>
                            {profile.execution === 'cloud' && (
                              <Field orientation="horizontal">
                                <Checkbox
                                  id={`egress-${profile.profileId}`}
                                  checked={acknowledged}
                                  disabled={!!busy}
                                  onCheckedChange={setAcknowledged}
                                />
                                <FieldContent>
                                  <FieldLabel
                                    htmlFor={`egress-${profile.profileId}`}
                                  >
                                    I authorize document processing by this
                                    cloud provider.
                                  </FieldLabel>
                                </FieldContent>
                              </Field>
                            )}
                            <div className={styles.actions}>
                              <Button
                                variant="outline"
                                disabled={!!busy}
                                onClick={() => setActivate(null)}
                              >
                                Cancel
                              </Button>
                              <Button
                                disabled={
                                  !!busy ||
                                  cloudUnavailable ||
                                  (profile.execution === 'cloud' &&
                                    !acknowledged)
                                }
                                onClick={() => void activateProfile(profile)}
                              >
                                {busy === 'activate:' + profile.profileId
                                  ? 'Activating…'
                                  : 'Activate engine'}
                              </Button>
                            </div>
                          </AlertDescription>
                        </Alert>
                      )}
                    {canManage && remove === profile.profileId && (
                      <Alert className={styles.confirm}>
                        <AlertTitle>Remove {profile.name}?</AlertTitle>
                        <AlertDescription>
                          <p>
                            It will leave the engine library. Existing jobs
                            retain their original configuration.
                          </p>
                          <div className={styles.actions}>
                            <Button
                              variant="outline"
                              disabled={!!busy}
                              onClick={() => setRemove(null)}
                            >
                              Keep profile
                            </Button>
                            <Button
                              variant="destructive"
                              disabled={!!busy}
                              onClick={() =>
                                void action('delete', async () => {
                                  await api(
                                    `/api/engines/${profile.profileId}`,
                                    'DELETE',
                                  );
                                  setRemove(null);
                                  await load();
                                  setNotice('Engine profile removed.');
                                })
                              }
                            >
                              Remove profile
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}
                  </article>
                );
              })}
            </div>
          </Panel>
          {canManage && (
            <Panel
              title="On your local runtime"
              subtitle="Discover installed Gemma, Qwen and other Ollama models. Discovery makes no inference request."
              action={
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void discover()}
                >
                  <RefreshCw data-icon="inline-start" />
                  {busy === 'discover' ? 'Discovering…' : 'Discover models'}
                </Button>
              }
            >
              <div className={styles.models}>
                {models.map((model) => (
                  <div className={styles.model} key={model.name}>
                    <Cpu />
                    <div>
                      <strong>{model.name}</strong>
                      <span>
                        {(model.size / 1e9).toFixed(2)} GB installed ·
                        capabilities not inspected here
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      aria-label={`Add ${model.name}`}
                      disabled={!!busy}
                      onClick={() => {
                        edit();
                        setDraft({
                          ...emptyDraft(),
                          name: model.name.split(':')[0] + ' · local',
                          model: model.name,
                        });
                      }}
                    >
                      <Plus />
                    </Button>
                  </div>
                ))}
                {!models.length && (
                  <p>
                    {discovered
                      ? 'No installed models were returned by the configured runtime.'
                      : 'Run discovery to view the models installed on this deployment.'}
                  </p>
                )}
              </div>
            </Panel>
          )}
          <p className={styles.footnote}>
            A connection test checks text connectivity and schema only. It does
            not test images. Test representative documents before changing your
            production engine. Financial stress calculations run
            deterministically and do not depend on the selected LLM.
          </p>
        </>
      )}
    </div>
  );
}
