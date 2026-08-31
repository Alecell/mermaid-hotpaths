export interface PackageOptions {
  name: string;
  packageName: string;
  file: string;
}

/**
 * Shared common options for both ESBuild and Vite
 */
export const packageOptions = {
  parser: {
    name: 'mermaid-parser',
    packageName: 'parser',
    file: 'index.ts',
  },
  mermaid: {
    name: 'mermaid',
    packageName: 'mermaid',
    file: 'mermaid.ts',
  },
  'mermaid-layout-elk': {
    name: 'mermaid-layout-elk',
    packageName: 'mermaid-layout-elk',
    file: 'layouts.ts',
  },
} as const satisfies Record<string, PackageOptions>;
