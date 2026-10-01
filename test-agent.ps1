az account show --output table

$token = az account get-access-token `
  --resource https://ai.azure.com `
  --query accessToken --output tsv

$endpoint = "https://capco-ai-studio.services.ai.azure.com/api/projects/hk-foundry"
$agent = "pruth-sale-agent-n6wz68ph4"

$result = Invoke-RestMethod `
  -Method Get `
  -Uri "$endpoint/agents/$agent`?api-version=v1" `
  -Headers @{
    Authorization = "Bearer $token"
    "Foundry-Features" = "VoiceAgents=V1Preview"
  }

$result.name