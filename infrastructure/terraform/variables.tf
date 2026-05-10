variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "aws_profile" {
  description = "AWS CLI profile"
  type        = string
  default     = "praveen"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "smartops"
}

variable "eks_cluster_name" {
  description = "Name of the existing EKS cluster (from e-commerce deployment)"
  type        = string
  default     = "ammazone-eks"
}

variable "eks_node_role_name" {
  description = "Name of the existing EKS node IAM role"
  type        = string
  default     = "ammazone-eks-node-role"
}

variable "account_id" {
  description = "AWS account ID"
  type        = string
  default     = "295284356306"
}
