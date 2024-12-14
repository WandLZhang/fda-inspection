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

# Determine the directory of the script.
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

# Get the cloud run custom audience from the main module ouputs.
echo "Getting the custom audience from the main Terraform module output..."
echo ""
AUDIENCE=$(
cd $REPO_ROOT/terraform/main
terraform init -backend-config="bucket=terraform-state-${PROJECT}" -backend-config="impersonate_service_account=$TF_VAR_terraform_service_account" > /dev/null 2>&1
terraform output -raw custom_audience_api
)
echo "AUDIENCE: $AUDIENCE"
echo ""

# Get an impersonated ID token with the cloud run custom audience from the Terraform provisioning service account.
echo "Getting an impersonated ID token with the custom audience..."
echo ""
TOKEN=$(gcloud auth print-identity-token --impersonate-service-account=$TF_VAR_terraform_service_account --audiences=$AUDIENCE)
echo ""

# Test the API endpoint.
echo "curl results:"
echo ""
curl -X GET -H "Authorization: Bearer ${TOKEN}" "${AUDIENCE}/health"
echo ""
echo ""
