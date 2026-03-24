export type ApiSupport = "full" | "partial" | "dashboard-only";

export interface ToolCatalogEntry {
  key: string;
  label: string;
  type: string;
  category: "default" | "custom" | "code" | "integration" | "client";
  apiSupport: ApiSupport;
  description: string;
  docsUrl: string;
  dashboardUrl?: string;
  composerPrompt?: string;
  apiNotes?: string;
  dashboardSteps?: string[];
  starterPayload?: Record<string, unknown>;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    key: "scheduler-bundle-bootstrap",
    label: "Scheduling Tool Bundle (Bootstrap)",
    type: "function",
    category: "custom",
    apiSupport: "full",
    description: "Create + optionally attach production-ready scheduling tools to an assistant in one API call.",
    docsUrl: "https://docs.vapi.ai/tools/custom-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "Explain when to use get_event_types, get_available_times, and create_booking in one call flow.",
    apiNotes:
      "Call POST /api/vapi/tools/bootstrap with serverUrl and assistantId. Runtime execution endpoint is /tools/vapi.",
    starterPayload: {
      assistantId: "assistant-id",
      serverUrl: "https://your-backend.example.com/tools/vapi",
      strict: true,
      includeGhlSyncTool: true,
      attachToAssistant: true,
      mode: "append"
    }
  },
  {
    key: "function-custom",
    label: "Custom Function Tool",
    type: "function",
    category: "custom",
    apiSupport: "full",
    description: "Webhook-based custom function with JSON-schema parameters.",
    docsUrl: "https://docs.vapi.ai/tools/custom-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "Show me best-practice function tool schema + prompt phrasing.",
    apiNotes: "Create via POST /tool and attach with assistant model.toolIds.",
    starterPayload: {
      type: "function",
      function: {
        name: "lookup_customer",
        description: "Look up customer profile by phone number.",
        parameters: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "Customer phone in E.164 format"
            }
          },
          required: ["phone"]
        }
      },
      server: {
        url: "https://your-server.example.com/vapi/tools/lookup-customer"
      },
      messages: []
    }
  },
  {
    key: "code-tool",
    label: "Code Tool (TypeScript)",
    type: "code",
    category: "code",
    apiSupport: "full",
    description: "Run TypeScript directly on Vapi infrastructure without hosting a webhook.",
    docsUrl: "https://docs.vapi.ai/tools/code-tool",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "Generate robust code tool with retries and structured return values.",
    apiNotes: "Supports parameters + environmentVariables; attach by toolIds.",
    starterPayload: {
      type: "code",
      name: "fetch_order_status",
      description: "Fetch order status from external API.",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "Order identifier"
          }
        },
        required: ["orderId"]
      },
      environmentVariables: [
        {
          name: "ORDER_API_KEY",
          value: "replace-me"
        }
      ],
      code: "const { orderId } = args;\nconst { ORDER_API_KEY } = env;\nconst res = await fetch(`https://api.example.com/orders/${orderId}`, { headers: { Authorization: `Bearer ${ORDER_API_KEY}` } });\nreturn await res.json();"
    }
  },
  {
    key: "api-request",
    label: "Default API Request Tool",
    type: "apiRequest",
    category: "default",
    apiSupport: "full",
    description: "Default tool type for HTTP API request actions from assistant.",
    docsUrl: "https://docs.vapi.ai/tools/default-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "How should I safely configure an apiRequest tool for outbound agents?",
    apiNotes: "Payload shape depends on endpoint/auth strategy; confirm in Dashboard preview before production.",
    starterPayload: {
      type: "apiRequest",
      name: "crm_lookup",
      description: "Lookup CRM record by phone",
      url: "https://your-server.example.com/api/lookup",
      method: "POST"
    }
  },
  {
    key: "transfer-call",
    label: "Default Transfer Call Tool",
    type: "transferCall",
    category: "default",
    apiSupport: "full",
    description: "Transfer live call to a phone number or assistant.",
    docsUrl: "https://docs.vapi.ai/tools/default-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "Best transferCall routing rules for warm lead qualification handoff?",
    starterPayload: {
      type: "transferCall",
      destinations: [
        {
          type: "number",
          number: "+15555550199",
          message: "Transferring you to a specialist now."
        }
      ]
    }
  },
  {
    key: "end-call",
    label: "Default End Call Tool",
    type: "endCall",
    category: "default",
    apiSupport: "full",
    description: "Gracefully end the call when objective is complete or disqualified.",
    docsUrl: "https://docs.vapi.ai/tools/default-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "What are clean endCall criteria for outbound campaigns?",
    starterPayload: {
      type: "endCall"
    }
  },
  {
    key: "dtmf",
    label: "Default DTMF Tool",
    type: "dtmf",
    category: "default",
    apiSupport: "full",
    description: "Send keypad tones for IVR navigation flows.",
    docsUrl: "https://docs.vapi.ai/tools/default-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "Help me design dtmf navigation for enterprise IVR phone trees.",
    starterPayload: {
      type: "dtmf"
    }
  },
  {
    key: "ghl-integration",
    label: "GoHighLevel Integration Tools",
    type: "goHighLevel",
    category: "integration",
    apiSupport: "partial",
    description: "Prebuilt GHL tool templates (get/create contact, check availability, create event).",
    docsUrl: "https://docs.vapi.ai/tools/go-high-level",
    dashboardUrl: "https://dashboard.vapi.ai/provider-keys",
    composerPrompt: "Walk me through GHL tool setup sequence and calendar mapping.",
    apiNotes: "Requires provider connection in Dashboard first; some config is easiest through Dashboard tool wizard.",
    dashboardSteps: [
      "Open Dashboard > Providers Keys > Tools Provider > GoHighLevel and connect account.",
      "Open Dashboard > Tools > Create Tool > GoHighLevel.",
      "Create each required GHL tool and then attach toolIds to assistant."
    ]
  },
  {
    key: "make-integration",
    label: "Make Integration Tools",
    type: "make",
    category: "integration",
    apiSupport: "partial",
    description: "Import and trigger Make scenarios as voice tools.",
    docsUrl: "https://docs.vapi.ai/tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "How should I structure Make scenarios for low-latency voice calls?",
    apiNotes: "Scenario import and provider auth typically start in Dashboard; then attach generated toolIds via API.",
    dashboardSteps: [
      "Connect Make provider keys in Dashboard.",
      "Import scenario into Tools section.",
      "Attach resulting tool to assistant and test in Composer."
    ]
  },
  {
    key: "google-calendar-integration",
    label: "Google Calendar Integration Tools",
    type: "google.calendar",
    category: "integration",
    apiSupport: "partial",
    description: "Calendar availability and event actions through integration tools.",
    docsUrl: "https://docs.vapi.ai/changelog/2025/6/3",
    dashboardUrl: "https://dashboard.vapi.ai/provider-keys",
    composerPrompt: "How do I configure Google Calendar tool auth and conflict handling?",
    apiNotes: "Tool CRUD may be available once OAuth/provider keys are connected; setup is safer through Dashboard first.",
    dashboardSteps: [
      "Connect Google provider under Dashboard > Providers Keys.",
      "Create or import Google Calendar tools in Dashboard > Tools.",
      "Attach toolIds to assistant; validate in Composer before outbound use."
    ]
  },
  {
    key: "slack-integration",
    label: "Slack Integration Tools",
    type: "slack",
    category: "integration",
    apiSupport: "partial",
    description: "Post messages or trigger Slack workflow actions from calls.",
    docsUrl: "https://docs.vapi.ai/changelog/2025/6/3",
    dashboardUrl: "https://dashboard.vapi.ai/provider-keys",
    composerPrompt: "Show me safe Slack escalation patterns for voice support.",
    apiNotes: "Depends on workspace OAuth/provider setup. Configure connection in Dashboard first.",
    dashboardSteps: [
      "Connect Slack provider in Dashboard > Providers Keys.",
      "Create Slack tool in Dashboard > Tools.",
      "Attach and test with Composer before production rollout."
    ]
  },
  {
    key: "client-side-tools",
    label: "Client-side Tools (Web SDK)",
    type: "client-side",
    category: "client",
    apiSupport: "dashboard-only",
    description: "Browser/client hosted tools (SDK-specific) for web call contexts.",
    docsUrl: "https://docs.vapi.ai/tools/client-side-tools",
    dashboardUrl: "https://dashboard.vapi.ai/tools",
    composerPrompt: "When should I use client-side tools vs server-side function tools?",
    apiNotes: "Configured primarily through SDK + assistant settings; no single generic server API flow for all use cases.",
    dashboardSteps: [
      "Open the client-side tools docs and SDK examples.",
      "Implement tool handlers in your web client runtime.",
      "Reference tool in assistant configuration and validate in web call testing."
    ]
  }
];
