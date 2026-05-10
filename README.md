# SmartOps Agent

Autonomous incident resolution system for the Ammazone e-commerce platform. Monitors production infrastructure, diagnoses failures using a multi-step LLM reasoning chain, proposes code fixes, and manages the full human-approval lifecycle through Slack.

## Architecture

```
CloudWatch Logs (EKS)  ──>  Incident Detector  ──>  LLM Reasoning Chain  ──>  Slack Notification
CloudWatch Alarms/SNS  ──>       (30s poll)          (3-step: diagnose,        (Block Kit with
                                                      locate, fix)              Approve/Reject/
                                                           |                    Suggest buttons)
                                                           |                         |
                                                      Pinecone (Vector DB)     SRE clicks Approve
                                                      NVIDIA NIM (Qwen3-480B)       |
                                                                               GitHub: branch +
                                                                               commit + PR + merge
                                                                                     |
                                                                               GitHub Actions CI/CD
                                                                               (rebuild + redeploy)
```

## Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Agent Core | Node.js 22 | Incident lifecycle state machine |
| LLM Engine | NVIDIA NIM (Qwen3-Coder-480B) | Multi-step reasoning chain |
| Vector DB | Pinecone (Serverless Free Tier) | Code knowledge base for context retrieval |
| Embeddings | NVIDIA NIM (nv-embedqa-e5-v5) | Source code embedding generation |
| Messaging | Slack Web API | Interactive incident notifications |
| Webhook Router | AWS API Gateway (HTTP API) | Public endpoint for Slack and GitHub webhooks |
| Audit Ledger | AWS CloudWatch Logs + S3 | Immutable log of every agent action |
| Alarm Pipeline | AWS SNS + SQS | Infrastructure alarm delivery |
| Container Registry | AWS ECR | Agent Docker image storage |
| Orchestration | AWS EKS (shared cluster) | Runs in isolated `smartops-system` namespace |

## Incident Resolution Flow

1. **Detection**: The agent continuously polls CloudWatch Logs from the `ammazone` EKS namespace for error patterns (500s, unhandled exceptions, connection failures). It also consumes CloudWatch Alarm messages via SQS for pod crashes and resource exhaustion.

2. **Diagnosis (LLM Step 1)**: Error logs are sent to the Qwen3-Coder-480B model. The LLM classifies the error type, identifies the root cause, lists affected files, and assigns a severity level.

3. **Context Retrieval (Step 2)**: The agent queries Pinecone for relevant source code chunks and fetches recent git diffs from the target repository to understand what changed recently.

4. **Fix Generation (LLM Step 3)**: The diagnosed error, retrieved source code, and recent diffs are sent to the LLM, which generates a complete code fix with file paths and explanations.

5. **Slack Notification**: A rich Block Kit message is posted to the designated Slack channel with the incident summary, proposed diff, and three buttons: Approve, Reject, and Suggest Changes.

6. **Human Approval**: An SRE reviews the proposed fix and clicks a button.
   - **Approve**: The agent creates a feature branch, commits the fix, opens a PR, and auto-merges it. GitHub Actions then rebuilds and redeploys the affected service.
   - **Reject**: The incident is closed and logged.
   - **Suggest**: The SRE replies in the Slack thread with feedback. The agent re-runs the fix generation step with the human suggestion and posts a revised fix.

7. **Audit**: Every action (error detection, LLM prompts, LLM responses, Slack messages, approvals, commits) is logged to CloudWatch with large payloads stored in S3.

## Repository Structure

```
smartops-agent/
  src/
    index.js                      Main entry point
    config.js                     Environment variable loader
    server.js                     Express HTTP server (webhooks)
    core/
      incident-detector.js        Log watcher + alarm consumer
      reasoning-chain.js          3-step LLM orchestrator
      incident-manager.js         Incident lifecycle state machine
    integrations/
      llm-client.js               NVIDIA NIM (OpenAI-compatible)
      embedding-client.js         NVIDIA NIM embeddings
      pinecone-client.js          Pinecone vector operations
      github-client.js            GitHub REST API
      slack-client.js             Slack Web API
    audit/
      audit-logger.js             CloudWatch Logs writer
      s3-store.js                 S3 payload storage
    indexer/
      code-indexer.js             Repo indexing pipeline
      webhook-handler.js          GitHub push webhook handler
    slack/
      block-kit.js                Message templates
      interaction-handler.js      Button click handler
      thread-listener.js          Suggestion reply reader
  infrastructure/
    terraform/                    S3, CloudWatch, API GW, SNS/SQS, IAM
    k8s/                          Namespace, Deployment, Service, Secrets
  Dockerfile
  package.json
```

## Prerequisites

Before deployment, you need:

1. The Ammazone EKS cluster must be running (`ammazone-eks` in `ap-south-1`)
2. A Pinecone account (free tier) with an API key from https://app.pinecone.io
3. A Slack App with the bot token and signing secret configured
4. An NVIDIA NIM API key from https://build.nvidia.com
5. A GitHub PAT with `repo` scope

## Deployment

### Step 1: Deploy Infrastructure

```powershell
cd r:\zzz_last_smartops\smartops-agent\infrastructure\terraform
terraform init
terraform apply -auto-approve
```

Save the outputs, particularly `api_gateway_url` and `sqs_queue_url`.

### Step 2: Configure Secrets

Encode your secrets as base64 and update `infrastructure/k8s/secrets.yaml`:

```powershell
# Generate base64 values
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("your-nvidia-api-key"))
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("your-pinecone-api-key"))
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("your-github-pat"))
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("your-slack-bot-token"))
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("your-slack-signing-secret"))
```

Update `infrastructure/k8s/configmap.yaml` with:
- `SLACK_CHANNEL_ID`: Your Slack channel ID
- `SQS_QUEUE_URL`: From Terraform output

### Step 3: Build and Push Docker Image

```powershell
cd r:\zzz_last_smartops\smartops-agent
aws ecr get-login-password --region ap-south-1 --profile praveen | docker login --username AWS --password-stdin 295284356306.dkr.ecr.ap-south-1.amazonaws.com
docker build -t 295284356306.dkr.ecr.ap-south-1.amazonaws.com/smartops-agent:latest .
docker push 295284356306.dkr.ecr.ap-south-1.amazonaws.com/smartops-agent:latest
```

### Step 4: Deploy to EKS

```powershell
kubectl apply -f infrastructure/k8s/namespace.yaml
kubectl apply -f infrastructure/k8s/secrets.yaml
kubectl apply -f infrastructure/k8s/configmap.yaml
kubectl apply -f infrastructure/k8s/deployment.yaml
kubectl apply -f infrastructure/k8s/service.yaml
```

### Step 5: Configure Slack Webhook URL

1. Go to your Slack App settings (https://api.slack.com/apps)
2. Navigate to "Interactivity & Shortcuts"
3. Enable interactivity
4. Set the Request URL to: `{api_gateway_url}/slack/interactions`

### Step 6: Verify

```powershell
# Check pod status
kubectl get pods -n smartops-system

# View agent logs
kubectl logs -f deployment/smartops-agent -n smartops-system

# Tail the audit ledger
aws logs tail /smartops/agent/audit --follow --profile praveen --region ap-south-1
```

## CLI Observability

```powershell
# Real-time audit trail
aws logs tail /smartops/agent/audit --follow --profile praveen --region ap-south-1

# Filter by incident
aws logs filter-log-events --log-group-name /smartops/agent/audit --filter-pattern "{$.incident_id = \"INC-20260510-001\"}" --profile praveen --region ap-south-1

# View LLM prompt for an incident step
aws s3 cp s3://smartops-audit-295284356306/incidents/INC-20260510-001/step1-prompt.json - --profile praveen

# View LLM response
aws s3 cp s3://smartops-audit-295284356306/incidents/INC-20260510-001/step3-response.json - --profile praveen
```

## Audit Ledger Schema

Every agent action is recorded with the following structure:

| Field | Type | Description |
|-------|------|-------------|
| incident_id | string | Unique identifier (e.g., INC-20260510-001) |
| timestamp | ISO 8601 | When the action occurred |
| action_type | enum | One of: ERROR_DETECTED, DIFF_FETCHED, VECTOR_QUERY, LLM_PROMPT_SENT, LLM_RESPONSE_RECEIVED, SLACK_MESSAGE_SENT, SLACK_APPROVAL_RECEIVED, HUMAN_SUGGESTION_RECEIVED, COMMIT_PUSHED, PR_CREATED, PR_MERGED, PIPELINE_TRIGGERED |
| input_payload | string | S3 URI or inline data (for small payloads) |
| output_payload | string | S3 URI or inline data |
| decision | string | approved, rejected, or null |
| actor | string | "agent" or Slack user ID |

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| Agent pod (t3.micro share) | ~$3 |
| S3 (audit payloads) | <$0.10 |
| CloudWatch Logs | <$0.50 |
| API Gateway HTTP API | Free (first 1M requests) |
| SNS + SQS | Free tier |
| ECR (image storage) | <$0.10 |
| NVIDIA NIM API | Free tier (40 RPM) |
| Pinecone | Free tier |
| **Total** | **~$3-5/month** |

## License

Internal project. Not for public distribution.
