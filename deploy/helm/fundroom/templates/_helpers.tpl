{{/* ---------------------------------------------------------------- names -- */}}

{{- define "fundroom.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "fundroom.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Resource names are suffixed, so keep the prefix short enough for the longest suffix. */}}
{{- define "fundroom.prefix" -}}
{{- include "fundroom.fullname" . | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "fundroom.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "fundroom.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fundroom.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "fundroom.labels" -}}
helm.sh/chart: {{ include "fundroom.chart" . }}
{{ include "fundroom.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: fundroom
{{- end -}}

{{/* Usage: include "fundroom.componentSelectorLabels" (list . "server") */}}
{{- define "fundroom.componentSelectorLabels" -}}
{{ include "fundroom.selectorLabels" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- define "fundroom.componentLabels" -}}
{{ include "fundroom.labels" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- define "fundroom.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "fundroom.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "fundroom.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "fundroom.configMapName" -}}{{ include "fundroom.prefix" . }}-config{{- end -}}
{{- define "fundroom.chartSecretName" -}}{{ include "fundroom.prefix" . }}-env{{- end -}}
{{- define "fundroom.migrateHookName" -}}{{ include "fundroom.prefix" . }}-migrate{{- end -}}
{{- define "fundroom.cnpgClusterName" -}}{{ include "fundroom.prefix" . }}-pg{{- end -}}

{{/* The Secret the containers load: the operator's, or the chart's. */}}
{{- define "fundroom.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "fundroom.chartSecretName" . -}}
{{- end -}}
{{- end -}}

{{/* The migrate hook cannot read the chart's own Secret (it does not exist yet on install). */}}
{{- define "fundroom.migrateSecretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "fundroom.migrateHookName" . -}}
{{- end -}}
{{- end -}}

{{/* Mirror of SECRET_KEYS in packages/config/src/schema.ts, plus the old names in LEGACY_ENV_NAMES
     (still read by the app): never allowed in config.extra. */}}
{{- define "fundroom.secretEnvKeys" -}}
{{- list "DATABASE_URL" "FUNDROOM_SECRET_KEY" "SEEDHOST_SECRET_KEY" "SECRET_KEY_RING" "SESSION_SECRET" "OIDC_CLIENT_SECRET" "S3_SECRET_ACCESS_KEY" "SMTP_URL" "RESEND_API_KEY" "RESEND_WEBHOOK_SECRET" "POSTMARK_SERVER_TOKEN" "POSTMARK_WEBHOOK_PASSWORD" "AWS_SECRET_ACCESS_KEY" "AWS_SESSION_TOKEN" "ERROR_REPORTING_DSN" "METRICS_TOKEN" "SETUP_TOKEN" "STRIPE_SECRET_KEY" "STRIPE_WEBHOOK_SECRET" "SANCTIONS_OPENSANCTIONS_API_KEY" "CLOUDFLARE_API_TOKEN" "INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET" "INTEGRATIONS_XERO_CLIENT_SECRET" "INTEGRATIONS_SLACK_CLIENT_SECRET" "DIRECTORY_DATABASE_URL" "AI_API_KEY" "AUTHZ_OPENFGA_API_TOKEN" "EDGE_SHARED_SECRET" "EDGE_SHARED_SECRET_PREVIOUS" | toJson -}}
{{- end -}}

{{/* Env keys the chart sets itself (ConfigMap, Secret or container env): not allowed in *.extra. */}}
{{- define "fundroom.reservedEnvKeys" -}}
{{- list
  "APP_ENV" "BASE_URL" "BASE_PATH" "PATH_MOUNTS" "TRUST_PROXY" "TRUST_PROXY_HOPS" "CLIENT_IP_HEADER" "TENANCY_MODE" "INSTANCE_NAME" "LOG_LEVEL" "MODULES"
  "MAILER_DRIVER" "MAIL_FROM" "MAIL_FROM_NAME" "CUSTOM_DOMAIN_DRIVER" "CUSTOM_DOMAIN_CNAME_TARGET"
  "AV_DRIVER" "CLAMD_HOST" "AV_ACCEPT_UNSCANNED" "METRICS_ENABLED" "UPDATE_CHECK" "OTEL_EXPORTER_OTLP_ENDPOINT"
  "STORAGE_DRIVER" "STORAGE_FS_PATH" "S3_BUCKET" "S3_REGION" "S3_ENDPOINT" "S3_FORCE_PATH_STYLE"
  "S3_ACCESS_KEY_ID" "S3_SECRET_ACCESS_KEY"
  "FUNDROOM_SECRET_KEY" "SEEDHOST_SECRET_KEY" "SECRET_KEY_RING" "SETUP_TOKEN" "SMTP_URL" "METRICS_TOKEN" "DATABASE_URL"
  "ROLES" "WORKER_MODE" "WORKER_CONCURRENCY" "MIGRATE_ON_START" "DATABASE_WAIT_TIMEOUT_MS"
  "HOST" "PORT" "DATA_DIR" "WEB_DIST_PATH"
  "DATA_REGION" "DATA_REGION_LABEL" "DATA_REGION_JURISDICTION" "BACKUP_LOCATION"
  "DIRECTORY_DATABASE_URL" "DIRECTORY_DATABASE_POOL_MAX" "DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS" "MOVE_SOURCE_RETENTION_HOURS" "MOVE_MAX_BUNDLE_BYTES" | toJson -}}
{{- end -}}

{{/*
"true" when the app pods migrate on start instead of relying on the migrate hook. Only ever with
postgresql.mode=cnpg, whose database does not exist while pre-install hooks run. `auto` means the
first `helm install` only (.Release.IsInstall); tools that always render as an install (Argo CD,
`helm template | kubectl apply`) should say `true` or `false` explicitly.
*/}}
{{- define "fundroom.migrateOnStart" -}}
{{- if eq .Values.postgresql.mode "cnpg" -}}
{{- $m := toString .Values.postgresql.cnpg.migrateOnStart -}}
{{- if or (eq $m "true") (and (eq $m "auto") .Release.IsInstall) -}}true{{- end -}}
{{- end -}}
{{- end -}}

{{/* Render the migrate hook at all? Not when cnpg pods always migrate themselves. */}}
{{- define "fundroom.migrateHookEnabled" -}}
{{- if not (and (eq .Values.postgresql.mode "cnpg") (eq (toString .Values.postgresql.cnpg.migrateOnStart) "true")) -}}true{{- end -}}
{{- end -}}

{{/* "true" when this release joins a shared cell directory (E3.11): its URL is a chart value, or
     residency.directory.existingSecret names the Secret that holds it. */}}
{{- define "fundroom.directoryEnabled" -}}
{{- if or .Values.residency.directory.databaseUrl .Values.residency.directory.existingSecret -}}true{{- end -}}
{{- end -}}

{{/* ------------------------------------------------------------- validation -- */}}

{{- define "fundroom.validate" -}}
{{- $v := .Values -}}
{{- /* config.extra / secrets.extra: no credentials in the ConfigMap, and no key the chart sets
       itself (the chart's value would silently win, or the pod contract would break). */ -}}
{{- $secretKeys := include "fundroom.secretEnvKeys" . | fromJsonArray -}}
{{- $reserved := include "fundroom.reservedEnvKeys" . | fromJsonArray -}}
{{- range $k, $_ := $v.config.extra -}}
{{- if or (has $k $secretKeys) (hasSuffix "_FILE" $k) -}}
{{- fail (printf "fundroom: config.extra.%s is a secret (or a *_FILE secret path) and config.extra lands in a ConfigMap in plain text. Use %s instead (or put it in your secrets.existingSecret)." $k (ternary "its dedicated secrets.*/storage.s3.*/postgresql.external.url value" "secrets.extra" (has $k $reserved))) -}}
{{- end -}}
{{- if has $k $reserved -}}
{{- fail (printf "fundroom: config.extra.%s is set by the chart itself; use the dedicated value instead (see values.yaml / the README's values table)." $k) -}}
{{- end -}}
{{- end -}}
{{- range $k, $_ := $v.secrets.extra -}}
{{- if has $k $reserved -}}
{{- fail (printf "fundroom: secrets.extra.%s is set by the chart itself; use the dedicated value instead (see values.yaml / the README's values table)." $k) -}}
{{- end -}}
{{- end -}}
{{- if not $v.config.baseUrl -}}
{{- fail "fundroom: config.baseUrl is required (the public URL, e.g. --set config.baseUrl=https://investors.example.com)." -}}
{{- end -}}
{{- if and (has $v.config.appEnv (list "prod" "staging")) (not (hasPrefix "https://" $v.config.baseUrl)) -}}
{{- fail (printf "fundroom: config.baseUrl must use https when config.appEnv=%s (got %s)." $v.config.appEnv $v.config.baseUrl) -}}
{{- end -}}
{{- if and $v.config.pathMounts (eq $v.config.tenancyMode "multi") -}}
{{- fail "fundroom: config.pathMounts is not supported with config.tenancyMode=multi (per-workspace mounts belong to the managed-host control plane, E3.10)." -}}
{{- end -}}
{{- range $v.config.pathMounts -}}
{{- if and (has $v.config.appEnv (list "prod" "staging")) (not (hasPrefix "https://" .)) -}}
{{- fail (printf "fundroom: config.pathMounts entries must use https when config.appEnv=%s (got %s)." $v.config.appEnv .) -}}
{{- end -}}
{{- end -}}
{{- $s := $v.secrets -}}
{{- if $s.existingSecret -}}
{{- if or $s.secretKey $s.secretKeyRing $s.setupToken $s.smtpUrl $s.metricsToken $s.extra $v.storage.s3.accessKeyId $v.storage.s3.secretAccessKey -}}
{{- fail "fundroom: secrets.existingSecret is set, so put every secret value (FUNDROOM_SECRET_KEY, SMTP_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, …) in that Secret and leave secrets.* and storage.s3.accessKeyId/secretAccessKey empty." -}}
{{- end -}}
{{- else -}}
{{- if and (not $s.secretKey) (not $s.secretKeyRing) -}}
{{- fail "fundroom: a master key is required. Set secrets.secretKey (generate one with: openssl rand -base64 32), secrets.secretKeyRing, or secrets.existingSecret naming a Secret that contains FUNDROOM_SECRET_KEY (or, from before the rename, SEEDHOST_SECRET_KEY). Back the key up: without it encrypted data is unrecoverable." -}}
{{- end -}}
{{- if and $s.secretKey $s.secretKeyRing -}}
{{- fail "fundroom: set secrets.secretKey or secrets.secretKeyRing, not both (put the old key into the ring as v1)." -}}
{{- end -}}
{{- if and $s.metricsToken (lt (len $s.metricsToken) 16) -}}
{{- fail "fundroom: secrets.metricsToken must be at least 16 characters." -}}
{{- end -}}
{{- end -}}
{{- if and (has $v.config.appEnv (list "prod" "staging")) (not $v.config.mail.from) -}}
{{- fail (printf "fundroom: config.mail.from (MAIL_FROM) is required when config.appEnv=%s." $v.config.appEnv) -}}
{{- end -}}
{{- if and (ne $v.config.mail.driver "smtp") (not $v.config.mail.from) -}}
{{- fail (printf "fundroom: config.mail.from (MAIL_FROM) is required with config.mail.driver=%s." $v.config.mail.driver) -}}
{{- end -}}
{{- if and (eq $v.config.mail.driver "smtp") (has $v.config.appEnv (list "prod" "staging")) (not $s.existingSecret) (not $s.smtpUrl) -}}
{{- fail "fundroom: secrets.smtpUrl (SMTP_URL) is required for config.mail.driver=smtp in prod/staging (or put SMTP_URL in secrets.existingSecret)." -}}
{{- end -}}
{{- $prodLike := has $v.config.appEnv (list "prod" "staging") -}}
{{- if and $prodLike (eq $v.config.av.driver "noop") (not $v.config.av.acceptUnscanned) -}}
{{- fail (printf "fundroom: config.appEnv=%s refuses unscanned uploads: set config.av.driver=clamd with config.av.clamdHost, or config.av.acceptUnscanned=true to run without a virus scanner on purpose." $v.config.appEnv) -}}
{{- end -}}
{{- if and $prodLike (eq (toString $v.config.metricsEnabled) "true") (not $s.existingSecret) (not $s.metricsToken) -}}
{{- fail (printf "fundroom: config.metricsEnabled=true needs secrets.metricsToken when config.appEnv=%s (openssl rand -hex 24), or leave metricsEnabled at auto/false." $v.config.appEnv) -}}
{{- end -}}
{{- if and (eq $v.config.av.driver "clamd") (not $v.config.av.clamdHost) -}}
{{- fail "fundroom: config.av.clamdHost is required with config.av.driver=clamd." -}}
{{- end -}}
{{- /* storage */ -}}
{{- if eq $v.storage.driver "fs" -}}
{{- if or (gt (int $v.server.replicaCount) 1) $v.worker.enabled -}}
{{- fail (printf "fundroom: storage.driver=fs keeps documents on one pod's volume, so it needs exactly one FundRoom pod (server.replicaCount=1 and worker.enabled=false; got replicaCount=%d, worker.enabled=%t). Use storage.driver=s3 for anything larger." (int $v.server.replicaCount) $v.worker.enabled) -}}
{{- end -}}
{{- else -}}
{{- if not $v.storage.s3.bucket -}}
{{- fail "fundroom: storage.s3.bucket is required with storage.driver=s3 (or set storage.driver=fs for a single-pod install)." -}}
{{- end -}}
{{- if and (not $v.storage.s3.region) (not $v.storage.s3.endpoint) -}}
{{- fail "fundroom: set storage.s3.region (AWS) or storage.s3.endpoint (R2, Garage, MinIO …)." -}}
{{- end -}}
{{- if and (not $s.existingSecret) (or (not $v.storage.s3.accessKeyId) (not $v.storage.s3.secretAccessKey)) -}}
{{- fail "fundroom: storage.s3.accessKeyId and storage.s3.secretAccessKey are required with storage.driver=s3 (or put S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY in secrets.existingSecret)." -}}
{{- end -}}
{{- end -}}
{{- /* database */ -}}
{{- $pg := $v.postgresql -}}
{{- if eq $pg.mode "external" -}}
{{- if and $pg.external.url $pg.external.existingSecret -}}
{{- fail "fundroom: set postgresql.external.url or postgresql.external.existingSecret, not both." -}}
{{- end -}}
{{- if and (not $pg.external.url) (not $pg.external.existingSecret) (not $s.existingSecret) -}}
{{- fail "fundroom: a database is required. Set postgresql.external.url (postgres://user:pass@host:5432/seedhost), postgresql.external.existingSecret, DATABASE_URL in secrets.existingSecret, or postgresql.mode=cnpg." -}}
{{- end -}}
{{- if and $pg.external.url $s.existingSecret -}}
{{- fail "fundroom: secrets.existingSecret is set, so put DATABASE_URL in it (or use postgresql.external.existingSecret) instead of postgresql.external.url." -}}
{{- end -}}
{{- if and $pg.external.url (not (regexMatch "^postgres(ql)?://" $pg.external.url)) -}}
{{- fail "fundroom: postgresql.external.url must be a postgres:// or postgresql:// URL." -}}
{{- end -}}
{{- if and $pg.external.caSecret $pg.external.url (not (contains (printf "sslrootcert=%s" (include "fundroom.dbCaPath" .)) $pg.external.url)) -}}
{{- fail (printf "fundroom: postgresql.external.caSecret is mounted at %s; add sslmode=verify-full&sslrootcert=%s to postgresql.external.url so the database certificate is verified against it." (include "fundroom.dbCaPath" .) (include "fundroom.dbCaPath" .)) -}}
{{- end -}}
{{- else -}}
{{- if or $pg.external.url $pg.external.existingSecret $pg.external.caSecret -}}
{{- fail "fundroom: postgresql.mode=cnpg uses the operator-generated credentials; leave postgresql.external.* empty." -}}
{{- end -}}
{{- if and $pg.cnpg.backup.enabled (or (not $pg.cnpg.backup.destinationPath) (not $pg.cnpg.backup.existingSecret)) -}}
{{- fail "fundroom: postgresql.cnpg.backup.enabled needs backup.destinationPath (s3://bucket/path) and backup.existingSecret (the object-store credentials)." -}}
{{- end -}}
{{- end -}}
{{- /* data residency (E3.11): the chart mirrors the config loader's cross-field rules so a bad
       combination fails `helm install`, not the migrate hook. */ -}}
{{- $r := $v.residency -}}
{{- if and (or $r.regionLabel $r.jurisdiction) (not $r.region) -}}
{{- fail "fundroom: residency.regionLabel and residency.jurisdiction need residency.region (DATA_REGION)." -}}
{{- end -}}
{{- if and $r.directory.databaseUrl $r.directory.existingSecret -}}
{{- fail "fundroom: set residency.directory.databaseUrl or residency.directory.existingSecret, not both." -}}
{{- end -}}
{{- if and $r.directory.databaseUrl $s.existingSecret -}}
{{- fail "fundroom: secrets.existingSecret is set, so put DIRECTORY_DATABASE_URL in it and set residency.directory.existingSecret to its name instead of residency.directory.databaseUrl." -}}
{{- end -}}
{{- if include "fundroom.directoryEnabled" . -}}
{{- if ne (toString (index $v.config.extra "CONTROL_PLANE")) "on" -}}
{{- fail "fundroom: a cell directory (residency.directory.*) needs the control plane: set config.extra.CONTROL_PLANE: \"on\" (and config.tenancyMode: multi)." -}}
{{- end -}}
{{- if or (not $r.region) (not $r.jurisdiction) -}}
{{- fail "fundroom: a cell directory (residency.directory.*) needs residency.region and residency.jurisdiction: every cell in a directory declares its region." -}}
{{- end -}}
{{- if and $prodLike (ne $v.storage.driver "s3") -}}
{{- fail (printf "fundroom: a cell directory (residency.directory.*) needs storage.driver=s3 when config.appEnv=%s: moves hand export bundles between cells over presigned URLs." $v.config.appEnv) -}}
{{- end -}}
{{- end -}}
{{- if and $v.ingress.enabled (not (include "fundroom.ingressHost" .)) -}}
{{- fail "fundroom: ingress.enabled needs a host: set ingress.host or a config.baseUrl with a hostname." -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------- config -- */}}

{{- define "fundroom.ingressHost" -}}
{{- default (urlParse .Values.config.baseUrl).hostname .Values.ingress.host -}}
{{- end -}}

{{/* Probe and Ingress paths follow BASE_PATH (the ops routes are mounted under it). */}}
{{- define "fundroom.path" -}}
{{- printf "%s%s" .root.Values.config.basePath .path -}}
{{- end -}}

{{/* ConfigMap data: non-secret env shared by every FundRoom container. */}}
{{- define "fundroom.configData" -}}
{{- $c := .Values.config -}}
APP_ENV: {{ $c.appEnv | quote }}
BASE_URL: {{ $c.baseUrl | quote }}
{{- if $c.basePath }}
BASE_PATH: {{ $c.basePath | quote }}
{{- end }}
{{- if $c.pathMounts }}
PATH_MOUNTS: {{ join "," $c.pathMounts | quote }}
{{- end }}
TRUST_PROXY: {{ $c.trustProxy | toString | quote }}
{{- if $c.trustProxy }}
TRUST_PROXY_HOPS: {{ $c.trustProxyHops | default 1 | toString | quote }}
{{- if $c.clientIpHeader }}
CLIENT_IP_HEADER: {{ $c.clientIpHeader | quote }}
{{- end }}
{{- end }}
TENANCY_MODE: {{ $c.tenancyMode | quote }}
INSTANCE_NAME: {{ $c.instanceName | quote }}
LOG_LEVEL: {{ $c.logLevel | quote }}
{{- if $c.modules }}
MODULES: {{ $c.modules | quote }}
{{- end }}
MAILER_DRIVER: {{ $c.mail.driver | quote }}
{{- if $c.mail.from }}
MAIL_FROM: {{ $c.mail.from | quote }}
{{- end }}
{{- if $c.mail.fromName }}
MAIL_FROM_NAME: {{ $c.mail.fromName | quote }}
{{- end }}
CUSTOM_DOMAIN_DRIVER: {{ $c.customDomains.driver | quote }}
{{- if $c.customDomains.cnameTarget }}
CUSTOM_DOMAIN_CNAME_TARGET: {{ $c.customDomains.cnameTarget | quote }}
{{- end }}
AV_DRIVER: {{ $c.av.driver | quote }}
{{- if $c.av.clamdHost }}
CLAMD_HOST: {{ $c.av.clamdHost | quote }}
{{- end }}
{{- if $c.av.acceptUnscanned }}
AV_ACCEPT_UNSCANNED: "true"
{{- end }}
{{- if ne (toString $c.metricsEnabled) "auto" }}
METRICS_ENABLED: {{ $c.metricsEnabled | toString | quote }}
{{- end }}
UPDATE_CHECK: {{ $c.updateCheck | toString | quote }}
{{- if $c.otelExporterOtlpEndpoint }}
OTEL_EXPORTER_OTLP_ENDPOINT: {{ $c.otelExporterOtlpEndpoint | quote }}
{{- end }}
STORAGE_DRIVER: {{ .Values.storage.driver | quote }}
{{- if eq .Values.storage.driver "s3" }}
{{- $s3 := .Values.storage.s3 }}
S3_BUCKET: {{ $s3.bucket | quote }}
{{- if $s3.region }}
S3_REGION: {{ $s3.region | quote }}
{{- end }}
{{- if $s3.endpoint }}
S3_ENDPOINT: {{ $s3.endpoint | quote }}
{{- end }}
S3_FORCE_PATH_STYLE: {{ $s3.forcePathStyle | toString | quote }}
{{- else }}
STORAGE_FS_PATH: "/data/storage"
{{- end }}
{{- $r := .Values.residency }}
{{- if $r.region }}
DATA_REGION: {{ $r.region | quote }}
{{- end }}
{{- if $r.regionLabel }}
DATA_REGION_LABEL: {{ $r.regionLabel | quote }}
{{- end }}
{{- if $r.jurisdiction }}
DATA_REGION_JURISDICTION: {{ $r.jurisdiction | quote }}
{{- end }}
{{- if $r.backupLocation }}
BACKUP_LOCATION: {{ $r.backupLocation | quote }}
{{- end }}
{{- if include "fundroom.directoryEnabled" . }}
DIRECTORY_DATABASE_POOL_MAX: {{ $r.directory.poolMax | int | toString | quote }}
{{- if $r.directory.acceptUnverifiedTls }}
DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS: "true"
{{- end }}
MOVE_SOURCE_RETENTION_HOURS: {{ $r.moves.sourceRetentionHours | int | toString | quote }}
MOVE_MAX_BUNDLE_BYTES: {{ $r.moves.maxBundleBytes | int64 | toString | quote }}
{{- end }}
{{- range $k, $val := $c.extra }}
{{ $k }}: {{ $val | toString | quote }}
{{- end }}
{{- end -}}

{{/* Secret stringData (only when the chart owns the Secret). */}}
{{- define "fundroom.secretData" -}}
{{- $s := .Values.secrets -}}
{{- if $s.secretKey }}
FUNDROOM_SECRET_KEY: {{ $s.secretKey | quote }}
{{- /* A-2: the pre-rename name too, same value, for one minor release. A pod of an older image
       (an old ReplicaSet pod restarted mid-rollout, a rollback) reads only SEEDHOST_SECRET_KEY
       and, finding no key, would generate a throwaway one into /data. Equal values are accepted
       by the new image (with a warning). */}}
SEEDHOST_SECRET_KEY: {{ $s.secretKey | quote }}
{{- end }}
{{- if $s.secretKeyRing }}
SECRET_KEY_RING: {{ $s.secretKeyRing | quote }}
{{- end }}
{{- /* One token for every replica: the wizard's POST may land on any pod. Derived, so it is stable
       across upgrades and `helm template` without a lookup; SHA-256 does not reveal the key. */}}
SETUP_TOKEN: {{ default (printf "seed-host-setup-token:%s%s" $s.secretKey $s.secretKeyRing | sha256sum | trunc 48) $s.setupToken | quote }}
{{- if $s.smtpUrl }}
SMTP_URL: {{ $s.smtpUrl | quote }}
{{- end }}
{{- if $s.metricsToken }}
METRICS_TOKEN: {{ $s.metricsToken | quote }}
{{- end }}
{{- if and (eq .Values.storage.driver "s3") .Values.storage.s3.accessKeyId }}
S3_ACCESS_KEY_ID: {{ .Values.storage.s3.accessKeyId | quote }}
S3_SECRET_ACCESS_KEY: {{ .Values.storage.s3.secretAccessKey | quote }}
{{- end }}
{{- if and (eq .Values.postgresql.mode "external") .Values.postgresql.external.url }}
DATABASE_URL: {{ .Values.postgresql.external.url | quote }}
{{- end }}
{{- if .Values.residency.directory.databaseUrl }}
DIRECTORY_DATABASE_URL: {{ .Values.residency.directory.databaseUrl | quote }}
{{- end }}
{{- range $k, $val := $s.extra }}
{{ $k }}: {{ $val | toString | quote }}
{{- end }}
{{- end -}}

{{/*
The migrate hook's own Secret: only what `fundroom migrate` needs. It is a hook resource, so a
failed hook leaves it behind until the next attempt and `helm uninstall` never deletes it; keep it
to the master key (config validation requires one), DATABASE_URL and, with a cell directory,
DIRECTORY_DATABASE_URL (`migrate` applies the directory's migrations too). Validation of the other
drivers is satisfied by the hook's env overrides (migrate-job.yaml), not by their credentials.
*/}}
{{- define "fundroom.migrateSecretData" -}}
{{- $s := .Values.secrets -}}
{{- if $s.secretKey }}
FUNDROOM_SECRET_KEY: {{ $s.secretKey | quote }}
{{- /* A-2: the pre-rename name too, same value, for one minor release. A pod of an older image
       (an old ReplicaSet pod restarted mid-rollout, a rollback) reads only SEEDHOST_SECRET_KEY
       and, finding no key, would generate a throwaway one into /data. Equal values are accepted
       by the new image (with a warning). */}}
SEEDHOST_SECRET_KEY: {{ $s.secretKey | quote }}
{{- end }}
{{- if $s.secretKeyRing }}
SECRET_KEY_RING: {{ $s.secretKeyRing | quote }}
{{- end }}
{{- if and (eq .Values.postgresql.mode "external") .Values.postgresql.external.url }}
DATABASE_URL: {{ .Values.postgresql.external.url | quote }}
{{- end }}
{{- if .Values.residency.directory.databaseUrl }}
DIRECTORY_DATABASE_URL: {{ .Values.residency.directory.databaseUrl | quote }}
{{- end }}
{{- end -}}

{{/* DATABASE_URL (and DIRECTORY_DATABASE_URL) when it does not come through envFrom (CNPG, or a
     dedicated Secret). */}}
{{- define "fundroom.databaseEnv" -}}
{{- if eq .Values.postgresql.mode "cnpg" }}
{{- /* E2.10 F-09: TLS to the CNPG primary, verified against the operator's own CA (mounted by
       fundroom.volumes). `$(VAR)` is Kubernetes' dependent-env expansion; the operator's `uri`
       carries no query string. */}}
- name: FUNDROOM_CNPG_URI
  valueFrom:
    secretKeyRef:
      name: {{ include "fundroom.cnpgClusterName" . }}-app
      key: uri
- name: DATABASE_URL
  value: "$(FUNDROOM_CNPG_URI)?sslmode=verify-full&sslrootcert={{ include "fundroom.dbCaPath" . }}"
{{- else if .Values.postgresql.external.existingSecret }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgresql.external.existingSecret }}
      key: {{ .Values.postgresql.external.existingSecretKey }}
{{- end }}
{{- with .Values.residency.directory.existingSecret }}
- name: DIRECTORY_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: {{ $.Values.residency.directory.existingSecretKey }}
{{- end }}
{{- end -}}

{{/* ------------------------------------------------------------------ pods -- */}}

{{/* Args: (dict "root" $ "hook" bool). The migrate hook never mounts the fs PVC: it writes
     nothing there, and on upgrade a ReadWriteOnce claim is still attached to the running server
     (possibly on another node), which would leave the Job pending. */}}
{{- define "fundroom.volumes" -}}
{{- $root := .root -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ $root.Values.tmpSizeLimit }}
- name: data
{{- if and (not .hook) (eq $root.Values.storage.driver "fs") $root.Values.persistence.enabled }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-data" (include "fundroom.prefix" $root)) $root.Values.persistence.existingClaim }}
{{- else if and (not .hook) (eq $root.Values.storage.driver "fs") }}
  emptyDir: {}
{{- else }}
  # DATA_DIR scratch only: the master key and the setup token come from the Secret and
  # documents from S3{{ if .hook }} (or, for fs storage, from the server's volume){{ end }}, so nothing durable is written here.
  {{- if not .hook }}
  # Workspace exports (<DATA_DIR>/portability/) and moves between cells (<DATA_DIR>/moves/) spool here.
  {{- end }}
  emptyDir:
    sizeLimit: {{ if .hook }}64Mi{{ else }}{{ $root.Values.dataScratchSizeLimit }}{{ end }}
{{- end }}
{{- if eq $root.Values.postgresql.mode "cnpg" }}
# The operator-generated CA (`<cluster>-ca`); only the certificate, never its key.
- name: db-ca
  secret:
    secretName: {{ include "fundroom.cnpgClusterName" $root }}-ca
    items:
      - key: ca.crt
        path: ca.crt
{{- else if $root.Values.postgresql.external.caSecret }}
# The external database's CA (postgresql.external.caSecret), for sslrootcert.
- name: db-ca
  secret:
    secretName: {{ $root.Values.postgresql.external.caSecret }}
    items:
      - key: {{ $root.Values.postgresql.external.caSecretKey }}
        path: ca.crt
{{- end }}
{{- end -}}

{{- define "fundroom.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: data
  mountPath: /data
{{- if or (eq .Values.postgresql.mode "cnpg") .Values.postgresql.external.caSecret }}
- name: db-ca
  mountPath: /etc/seed-host/db-ca
  readOnly: true
{{- end }}
{{- end -}}

{{/* The database CA certificate inside the pods (sslrootcert): CNPG's, or postgresql.external.caSecret. */}}
{{- define "fundroom.dbCaPath" -}}/etc/seed-host/db-ca/ca.crt{{- end -}}

{{/* Everything but ROLES & co: image, security, env sources. Args: (dict "root" $ "hook" bool) */}}
{{- define "fundroom.containerCommon" -}}
{{- $root := .root -}}
image: {{ include "fundroom.image" $root }}
imagePullPolicy: {{ $root.Values.image.pullPolicy }}
securityContext:
  {{- toYaml $root.Values.securityContext | nindent 2 }}
envFrom:
  - configMapRef:
      name: {{ if .hook }}{{ include "fundroom.migrateHookName" $root }}{{ else }}{{ include "fundroom.configMapName" $root }}{{ end }}
  - secretRef:
      name: {{ if .hook }}{{ include "fundroom.migrateSecretName" $root }}{{ else }}{{ include "fundroom.secretName" $root }}{{ end }}
volumeMounts:
  {{- include "fundroom.volumeMounts" $root | nindent 2 }}
{{- end -}}

{{- define "fundroom.podCommon" -}}
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end -}}

{{- define "fundroom.checksums" -}}
checksum/config: {{ include "fundroom.configData" . | sha256sum }}
checksum/secret: {{ include "fundroom.secretData" . | sha256sum }}
{{- end -}}
