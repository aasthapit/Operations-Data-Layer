# Onboarding live OpenShift clusters

This guide explains the expected format for pointing a list of live OpenShift cluster endpoints at the Operations Data Layer, using a single shared service account that authenticates with a username and password.

## How it connects

OpenShift's API server does not accept HTTP basic auth.
When you run `oc login -u <user> -p <pass>`, the CLI actually performs an OAuth2 "challenging client" flow against the cluster's OAuth server and receives a short-lived bearer token.
The collector reproduces exactly that flow: for each cluster it discovers the OAuth endpoint, exchanges the shared username/password for a bearer token, and uses that token to read the cluster's state.
Tokens are cached for 30 minutes and re-fetched automatically, so the credentials are exchanged a handful of times, not on every sweep.

The collector is strictly read-only.
It reads `ClusterVersion`, `ClusterOperator`, `Infrastructure`, `Node`, and `Deployment` resources, and nothing else.

## 1. Create the shared service account

"Service account that authenticates with user/pass" means an identity-provider user (for example an htpasswd or LDAP user), not a Kubernetes `ServiceAccount` (those use tokens).
Create one identity - for example `svc-ops-data` - in your identity provider, and make sure the same credentials are valid on every cluster you want to onboard.

If you would rather use a Kubernetes `ServiceAccount` token per cluster, that is supported too - use `auth: { type: token, token: ... }` instead of `password`.
The rest of this guide assumes the shared user/pass identity.

## 2. Grant it read-only access on every cluster

The identity needs read access to a handful of resources on each cluster.
Apply the bundled `ClusterRole` + `ClusterRoleBinding` to each cluster:

```sh
# Run against each cluster's API (switch contexts or KUBECONFIG per cluster).
oc apply -f deploy/rbac/odl-collector-readonly.yaml
```

The binding grants the `svc-ops-data` user the `odl-collector-readonly` role.
Edit the `subjects` in that file if your identity has a different name, or if you are binding a `ServiceAccount` instead of a user.

## 3. Write the cluster list

Copy [`data-layer/config/clusters.example.yaml`](../data-layer/config/clusters.example.yaml) to `data-layer/config/clusters.yaml` and fill it in.

The format has two sections:

```yaml
defaults:                      # shared settings applied to every cluster
  auth:
    type: password
    username: svc-ops-data
    password: ${OCP_PASSWORD}  # read from the environment, not stored in the file
  insecure_skip_tls_verify: false
  # ca_cert: /etc/odl/ca/ocp-ca.crt

clusters:
  - name: ocp-prod-east-1
    api_url: https://api.ocp-prod-east-1.example.com:6443
    region: us-east-1
    datacenter: iad1
    environment: prod
    hub: prod-east
  - name: ocp-prod-west-1
    api_url: https://api.ocp-prod-west-1.example.com:6443
    region: us-west-2
    datacenter: sjc1
    environment: prod
    hub: prod-west
```

### Field reference

| Field | Where | Meaning |
|---|---|---|
| `defaults.auth` | shared | Credentials applied to every cluster (overridable per cluster). |
| `auth.type` | shared / cluster | `password`, `token`, or `kubeconfig`. |
| `auth.username` / `auth.password` | shared / cluster | The shared service-account identity (for `type: password`). |
| `auth.token` | shared / cluster | A pre-minted bearer token (for `type: token`). |
| `insecure_skip_tls_verify` | shared / cluster | Skip TLS verification (dev only). |
| `ca_cert` | shared / cluster | Path to a CA bundle to trust the cluster's serving cert. |
| `name` | cluster | Unique cluster name shown everywhere. |
| `api_url` | cluster | The API server URL - `oc whoami --show-server` (`https://api.<domain>:6443`). |
| `region` / `datacenter` / `environment` | cluster | How the cluster is grouped in the dashboard and summaries. |
| `hub` | cluster | A logical grouping label (e.g. the owning ACM hub or fleet). |

Every string supports `${ENV_VAR}` substitution, so secrets such as the password never have to live in the file.

## 4. Point the data layer at it

Set `ODL_CONFIG` to the file and provide the password via the environment.
In `docker-compose.yml`, on the `api` service:

```yaml
    environment:
      ODL_CONFIG: /app/config/clusters.yaml
      OCP_PASSWORD: ${OCP_PASSWORD}      # exported in your shell or an .env file
    volumes:
      - ./data-layer/config:/app/config:ro
```

Then:

```sh
export OCP_PASSWORD='…'
docker compose up -d api
```

On OpenShift, mount the file from a `Secret` and set `ODL_CONFIG` accordingly; see [`deploy/openshift/`](../deploy/openshift/).

## 5. Verify

```sh
# Trigger a sweep and watch the result.
curl -s -X POST http://localhost:18000/api/refresh

# Did every cluster come back?
curl -s "http://localhost:18000/api/runs?limit=1" | python3 -m json.tool

# Fleet-wide health.
curl -s http://localhost:18000/api/health/overview | python3 -m json.tool
```

If a cluster cannot be reached or authenticated, it is not dropped - it is recorded with `reachable: false` and a `cluster-reachable` health check that fails, and the error is stored on the cluster row (`last_error`) and surfaced in the dashboard.
That makes credential or network problems visible rather than silent.

## Switching between modes

The data layer supports two discovery modes in the same config file, and you can use either or both:

- **Direct list** (`clusters:`) - the flow above; you enumerate endpoints.
- **ACM hubs** (`hubs:`) - you list ACM hubs and the collector discovers their `ManagedCluster`s automatically. This is what the local kind fleet uses (`data-layer/config/hubs.yaml`).

For a large estate, ACM-hub discovery scales better because you onboard a hub once instead of maintaining a per-cluster list.
The direct list is the simplest way to get started and to onboard clusters that are not under ACM.
