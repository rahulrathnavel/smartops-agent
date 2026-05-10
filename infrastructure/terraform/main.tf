# ─────────────────────────────────────────────────────────────────────────────
# SmartOps Agent Infrastructure
# Creates: S3 bucket, CloudWatch log group, API Gateway HTTP API,
#          SNS topic, SQS queue, ECR repo, IAM policies
# ─────────────────────────────────────────────────────────────────────────────

# ── S3 Bucket: Audit Ledger payload storage ─────────────────────────────────

resource "aws_s3_bucket" "audit" {
  bucket        = "${var.project_name}-audit-${var.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_lifecycle_configuration" "audit_lifecycle" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "expire-old-payloads"
    status = "Enabled"

    expiration {
      days = 90
    }
  }
}

# ── CloudWatch Log Group: Audit Ledger ──────────────────────────────────────

resource "aws_cloudwatch_log_group" "audit" {
  name              = "/smartops/agent/audit"
  retention_in_days = 90
}

# ── ECR Repository: Agent container image ───────────────────────────────────

resource "aws_ecr_repository" "agent" {
  name                 = "${var.project_name}-agent"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_lifecycle_policy" "agent_cleanup" {
  repository = aws_ecr_repository.agent.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# ── SNS Topic: CloudWatch Alarm notifications ───────────────────────────────

resource "aws_sns_topic" "alarms" {
  name = "${var.project_name}-alarms"
}

# ── SQS Queue: Alarm message consumer ──────────────────────────────────────

resource "aws_sqs_queue" "alarm_queue" {
  name                       = "${var.project_name}-alarm-queue"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 20
}

resource "aws_sqs_queue_policy" "allow_sns" {
  queue_url = aws_sqs_queue.alarm_queue.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSNS"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.alarm_queue.arn
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_sns_topic.alarms.arn }
      }
    }]
  })
}

resource "aws_sns_topic_subscription" "sqs" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.alarm_queue.arn
}

# ── API Gateway HTTP API: Slack + GitHub webhook endpoint ───────────────────

resource "aws_apigatewayv2_api" "webhooks" {
  name          = "${var.project_name}-webhooks"
  protocol_type = "HTTP"
  description   = "Public endpoint for Slack interactivity and GitHub push webhooks"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhooks.id
  name        = "$default"
  auto_deploy = true
}

# Routes forward to the EKS NodePort (31200)
# In production, this would use a VPC Link; for POC, we route via public NodePort

resource "aws_apigatewayv2_integration" "eks_proxy" {
  api_id             = aws_apigatewayv2_api.webhooks.id
  integration_type   = "HTTP_PROXY"
  integration_method = "POST"
  # This URI will be updated after EKS deployment with the actual node IP
  integration_uri = "http://placeholder:31200/{proxy}"
}

resource "aws_apigatewayv2_route" "slack" {
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "POST /slack/interactions"
  target    = "integrations/${aws_apigatewayv2_integration.eks_proxy.id}"
}

resource "aws_apigatewayv2_route" "github" {
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "POST /webhooks/github"
  target    = "integrations/${aws_apigatewayv2_integration.eks_proxy.id}"
}

# ── IAM Policy: Allow EKS nodes to access SmartOps resources ────────────────

data "aws_iam_role" "eks_nodes" {
  name = var.eks_node_role_name
}

resource "aws_iam_role_policy" "smartops_access" {
  name = "${var.project_name}-resource-access"
  role = data.aws_iam_role.eks_nodes.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.audit.arn,
          "${aws_s3_bucket.audit.arn}/*"
        ]
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "logs:FilterLogEvents",
          "logs:GetLogEvents"
        ]
        Resource = [
          aws_cloudwatch_log_group.audit.arn,
          "${aws_cloudwatch_log_group.audit.arn}:*",
          "arn:aws:logs:${var.aws_region}:${var.account_id}:log-group:/aws/eks/*"
        ]
      },
      {
        Sid      = "SQSAccess"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.alarm_queue.arn
      },
      {
        Sid      = "ECRPull"
        Effect   = "Allow"
        Action   = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.agent.arn
      }
    ]
  })
}
