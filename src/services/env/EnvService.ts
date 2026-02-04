/**
 * Environment Variables Management Service
 *
 * Handles .env file generation and encryption for repository-specific environment variables.
 * Each repository can have its own set of environment variables that are injected
 * when the repository is cloned to the workspace.
 *
 * Security:
 * - Sensitive variables (isSecret: true) are encrypted at rest in SQLite
 * - .env files are generated at runtime in workspace (never committed)
 * - Encryption uses AES-256-GCM with environment-specific secret key
 */
import fs from 'fs/promises';
import path from 'path';
import { CryptoService } from '../security/CryptoService.js';

export interface IEnvVariable {
  key: string;
  value: string;
  isSecret: boolean;
  description?: string;
}

export class EnvService {
  /**
   * Encrypt a secret value for storage
   */
  static encryptValue(plaintext: string): string {
    return CryptoService.encrypt(plaintext);
  }

  /**
   * Decrypt a secret value from storage
   */
  static decryptValue(encrypted: string): string {
    return CryptoService.decrypt(encrypted);
  }

  /**
   * Generate .env file content from environment variables
   * Handles decryption of secret variables
   */
  static generateEnvFileContent(envVariables: IEnvVariable[]): string {
    if (!envVariables || envVariables.length === 0) {
      return '# No environment variables configured for this repository\n';
    }

    let content = '# Environment Variables\n';
    content += '# Generated automatically by Multi-Agent Platform\n';
    content += '# DO NOT COMMIT THIS FILE\n\n';

    for (const envVar of envVariables) {
      // Add description as comment if available
      if (envVar.description) {
        content += `# ${envVar.description}\n`;
      }

      // Decrypt value if it's a secret
      const value = envVar.isSecret
        ? this.decryptValue(envVar.value)
        : envVar.value;

      content += `${envVar.key}=${value}\n`;

      if (envVar.description) {
        content += '\n'; // Extra newline after documented variables
      }
    }

    return content;
  }

  /**
   * Write .env file to repository workspace
   */
  static async writeEnvFile(
    repositoryPath: string,
    envVariables: IEnvVariable[]
  ): Promise<void> {
    if (!envVariables || envVariables.length === 0) {
      console.log('[EnvService] No environment variables to write');
      return;
    }

    try {
      const envFilePath = path.join(repositoryPath, '.env');
      const content = this.generateEnvFileContent(envVariables);

      await fs.writeFile(envFilePath, content, 'utf8');

      console.log(`[EnvService] Created .env file with ${envVariables.length} variable(s): ${envFilePath}`);
    } catch (error: any) {
      console.error('[EnvService] Failed to write .env file:', error);
      throw new Error(`Failed to create .env file: ${error.message}`);
    }
  }

  /**
   * Validate environment variable key format
   * Must be uppercase alphanumeric with underscores
   */
  static isValidEnvKey(key: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(key);
  }

  /**
   * Validate environment variables before saving
   */
  static validateEnvVariables(envVariables: IEnvVariable[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const envVar of envVariables) {
      if (!envVar.key) {
        errors.push('Environment variable key cannot be empty');
        continue;
      }

      if (!this.isValidEnvKey(envVar.key)) {
        errors.push(`Invalid key format: ${envVar.key} (must be uppercase alphanumeric with underscores)`);
      }

      if (envVar.value === undefined || envVar.value === null) {
        errors.push(`Value for ${envVar.key} cannot be empty`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Prepare environment variables for storage
   * Encrypts secret values before saving
   */
  static prepareForStorage(envVariables: IEnvVariable[]): IEnvVariable[] {
    return envVariables.map(envVar => ({
      ...envVar,
      value: envVar.isSecret ? this.encryptValue(envVar.value) : envVar.value,
    }));
  }

  /**
   * Check if .env file exists in repository
   */
  static async envFileExists(repositoryPath: string): Promise<boolean> {
    try {
      const envFilePath = path.join(repositoryPath, '.env');
      await fs.access(envFilePath);
      return true;
    } catch {
      return false;
    }
  }
}

export default EnvService;
