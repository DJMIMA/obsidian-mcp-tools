# MCP Tools for Obsidian - Plugin

The Obsidian plugin component of MCP Tools, providing secure MCP server integration for accessing Obsidian vaults through Claude Desktop and other MCP clients.

## Features

- **Secure Access**: All communication encrypted and authenticated through Local REST API
- **Semantic Search**: Builds its own embedding index (Cohere or any OpenAI-compatible API) for context-aware search
- **Template Support**: Execute Templater templates through MCP clients
- **File Management**: Comprehensive vault access and management capabilities
- **Security First**: Binary attestation and secure key management

## Requirements

### Required

- Obsidian v1.7.7 or higher
- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin

### Recommended

- [Templater](https://silentvoid13.github.io/Templater/) for template execution

## Development

This plugin is part of the MCP Tools monorepo. For development:

```bash
# Install dependencies
bun install

# Start development build with watch mode
bun run dev

# Create a production build
bun run build

# Link plugin to your vault for testing
bun run link <path-to-vault-config-file>
```

### Project Structure

```
src/
├── features/        # Feature modules
│   ├── core/        # Plugin initialization
│   ├── mcp-server/  # Server management
│   └── shared/      # Common utilities
├── main.ts          # Plugin entry point
└── shared/          # Shared types and utilities
```

### Adding New Features

1. Create a new feature module in `src/features/`
2. Implement the feature's setup function
3. Add any UI components to the settings tab
4. Register the feature in `main.ts`

## Security

This plugin follows strict security practices:

- All server binaries are signed and include SLSA provenance
- Communication is encrypted using Local REST API's TLS
- API keys are stored securely using platform-specific methods
- Server runs with minimal required permissions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Follow the project's TypeScript and Svelte guidelines
4. Submit a pull request

## License

[MIT License](LICENSE)
