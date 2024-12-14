#!/bin/bash
# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# The user completes these prerequisite commmands (Google Cloud Shell sets them up automatically):
# gcloud auth login
# gcloud config set project 'my-project-id' # replace 'my-project-id' with your project ID
# [OPTIONAL] gcloud config set compute/region us-central1

# Determine the directory of the script
if [ -n "$BASH_SOURCE" ]; then
  # Bash
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [ -n "$ZSH_VERSION" ]; then
  # Zsh
  SCRIPT_DIR="$(cd "$(dirname "${(%):-%N}")" && pwd)"
else
  # Fallback for other shells
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

# Set environment variables by sourcing the set_variables script.
echo "Setting environment variables..."
echo ""
source "$SCRIPT_DIR/set_variables.sh"

# Enable the Service Usage, IAM, and Service Account Credentials APIs.
echo "Enabling the Service Usage, IAM, and Service Account Credentials APIs..."
echo ""
gcloud services enable serviceusage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com
echo ""

# Create a service account for Terraform provisioning.
echo "Creating a service account for Terraform provisioning..."
echo ""
gcloud iam service-accounts create terraform-service-account --display-name="Terraform Provisioning Service Account" --project=$PROJECT
echo ""

# Grant the required IAM roles to the service account.
echo "Granting the required IAM roles to the service account..."
echo ""
roles=(
  "roles/aiplatform.admin"
  "roles/artifactregistry.admin"
  "roles/bigquery.admin"
  "roles/cloudbuild.builds.editor"
  "roles/redis.admin"
  "roles/compute.admin"
  "roles/discoveryengine.admin"
  "roles/dns.admin"
  "roles/resourcemanager.projectIamAdmin"
  "roles/run.admin"
  "roles/iam.securityAdmin"
  "roles/iam.serviceAccountAdmin"
  "roles/iam.serviceAccountUser"
  "roles/serviceusage.serviceUsageAdmin"
  "roles/storage.admin"
  "roles/workflows.admin"
)

for role in "${roles[@]}"; do
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$TF_VAR_terraform_service_account" --role=$role --condition=None
done
echo ""

# Grant the caller permission to impersonate the service account.
echo "Granting the caller permission to impersonate the service account..."
echo ""
user=$(gcloud config list --format='value(core.account)')
echo "User: $user"
echo ""
gcloud iam service-accounts add-iam-policy-binding $TF_VAR_terraform_service_account --member="user:${user}" --role="roles/iam.serviceAccountTokenCreator" --condition=None
echo ""

# Create a bucket for the Terraform state.
echo "Creating a bucket for the Terraform state..."
echo ""
gcloud storage buckets create "gs://${BUCKET}" --project=$PROJECT
echo ""

# Initialize the Terraform configuration in the main directory using a subshell.
echo "Initializing Terraform in the main directory..."
echo ""
(
cd $REPO_ROOT/terraform/main
terraform init -backend-config="bucket=$BUCKET" -backend-config="impersonate_service_account=$TF_VAR_terraform_service_account" -reconfigure
)
echo ""

# Initialize and apply Terraform in the boostrap directory using a subshell.
echo "Initializing Terraform in the bootstrap directory and applying the configuration..."
echo ""
(
cd $REPO_ROOT/terraform/bootstrap
terraform init -backend-config="bucket=$BUCKET" -backend-config="impersonate_service_account=$TF_VAR_terraform_service_account" -reconfigure
terraform apply
)
echo ""
