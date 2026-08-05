output "state_bucket_name" {
  description = "Name of the S3 bucket holding Terraform remote state — use this in the main module's backend configuration."
  value       = aws_s3_bucket.terraform_state.id
}

output "lock_table_name" {
  description = "Name of the DynamoDB table used for state locking — use this in the main module's backend configuration."
  value       = aws_dynamodb_table.terraform_lock.name
}
