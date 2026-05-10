output "s3_bucket_name" {
  description = "Audit ledger S3 bucket name"
  value       = aws_s3_bucket.audit.id
}

output "cloudwatch_log_group" {
  description = "Audit ledger CloudWatch log group"
  value       = aws_cloudwatch_log_group.audit.name
}

output "sqs_queue_url" {
  description = "SQS queue URL for alarm consumption"
  value       = aws_sqs_queue.alarm_queue.url
}

output "ecr_repository_url" {
  description = "ECR repository URL for the agent image"
  value       = aws_ecr_repository.agent.repository_url
}

output "api_gateway_url" {
  description = "Public API Gateway URL (paste into Slack App dashboard)"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch Alarm subscriptions"
  value       = aws_sns_topic.alarms.arn
}
