terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Bucket and table names come from bootstrap/'s outputs (Task 1) — filled in once that module
  # has been applied. Terraform's backend block can't reference variables or another module's
  # output, so these three values are the one place in this codebase where a real value has to be
  # typed in by hand after bootstrap/ runs, not left as a variable.
  backend "s3" {
    bucket         = "REPLACE_WITH_BOOTSTRAP_STATE_BUCKET_NAME_OUTPUT"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ruguin-terraform-lock"
    encrypt        = true
  }
}
