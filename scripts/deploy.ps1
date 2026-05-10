# ─────────────────────────────────────────────────────────────────
# SmartOps Agent - Full Deployment Script
# Run each section sequentially. Sections marked with estimated
# times exceeding 6 minutes should be run manually by the user.
# ─────────────────────────────────────────────────────────────────

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  SmartOps Agent - Deployment Sequence" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# ── STEP 1: Provision E-Commerce Infrastructure (~15 min) ────────
# This creates the EKS cluster, VPC, ECR repos, etc.
Write-Host "`n[STEP 1] Provisioning e-commerce EKS cluster..." -ForegroundColor Yellow
Set-Location "r:\zzz_last_smartops\e-commerce-base\infrastructure\terraform"
$env:Path = "$env:Path;C:\terraform"
terraform init
terraform apply -auto-approve

# Configure kubectl
aws eks update-kubeconfig --region ap-south-1 --name ammazone-eks --profile praveen

# ── STEP 2: Provision SmartOps Infrastructure (~2 min) ───────────
# This creates S3 bucket, CloudWatch log group, API Gateway, SNS/SQS, ECR
Write-Host "`n[STEP 2] Provisioning SmartOps infrastructure..." -ForegroundColor Yellow
Set-Location "r:\zzz_last_smartops\smartops-agent\infrastructure\terraform"
terraform init
terraform apply -auto-approve

# Capture the SQS queue URL from Terraform output
$SQS_URL = terraform output -raw sqs_queue_url
$API_GW_URL = terraform output -raw api_gateway_url
$ECR_URL = terraform output -raw ecr_repository_url

Write-Host "`nAPI Gateway URL: $API_GW_URL" -ForegroundColor Green
Write-Host "SQS Queue URL: $SQS_URL" -ForegroundColor Green
Write-Host "ECR URL: $ECR_URL" -ForegroundColor Green

# ── STEP 3: Build and Push Agent Docker Image (~2 min) ───────────
Write-Host "`n[STEP 3] Building and pushing agent Docker image..." -ForegroundColor Yellow
Set-Location "r:\zzz_last_smartops\smartops-agent"
aws ecr get-login-password --region ap-south-1 --profile praveen | docker login --username AWS --password-stdin 295284356306.dkr.ecr.ap-south-1.amazonaws.com
docker build -t "${ECR_URL}:latest" .
docker push "${ECR_URL}:latest"

# ── STEP 4: Deploy K8s Manifests (~30 sec) ───────────────────────
Write-Host "`n[STEP 4] Deploying to EKS..." -ForegroundColor Yellow

# Create namespace
kubectl apply -f infrastructure/k8s/namespace.yaml

# Apply local secrets (with real credentials)
kubectl apply -f infrastructure/k8s/secrets.local.yaml

# Update configmap with SQS URL and apply
$configContent = Get-Content infrastructure/k8s/configmap.yaml -Raw
$configContent = $configContent -replace 'SQS_QUEUE_URL: ""', "SQS_QUEUE_URL: `"$SQS_URL`""
$configContent | kubectl apply -f -

# Deploy agent
kubectl apply -f infrastructure/k8s/deployment.yaml
kubectl apply -f infrastructure/k8s/service.yaml

# ── STEP 5: Verify ──────────────────────────────────────────────
Write-Host "`n[STEP 5] Verifying deployment..." -ForegroundColor Yellow
Start-Sleep -Seconds 10
kubectl get pods -n smartops-system
kubectl get svc -n smartops-system

Write-Host "`n============================================" -ForegroundColor Green
Write-Host "  Deployment Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "`nNEXT STEPS:" -ForegroundColor Yellow
Write-Host "1. Go to https://api.slack.com/apps -> your app -> Interactivity" -ForegroundColor White
Write-Host "2. Set Request URL to: ${API_GW_URL}/slack/interactions" -ForegroundColor White
Write-Host "3. Tail audit logs: aws logs tail /smartops/agent/audit --follow --profile praveen --region ap-south-1" -ForegroundColor White
