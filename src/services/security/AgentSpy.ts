/**
 * Agent Spy - Comprehensive Vulnerability Detector
 *
 * SECURITY-FIRST: Monitors agent execution and detects ALL vulnerabilities.
 * Thinks like an attacker - systematic, exhaustive, paranoid.
 *
 * Categories of detection:
 * 1. Dangerous Commands (system destruction, privilege escalation)
 * 2. Secret Exposure (API keys, passwords, tokens, certificates)
 * 3. Code Injection (SQL, XSS, command, template)
 * 4. Path Traversal (sensitive file access)
 * 5. Data Exfiltration (unauthorized data transfer)
 * 6. Resource Exhaustion (DoS, memory bombs)
 * 7. Supply Chain Attacks (malicious packages)
 * 8. Privilege Escalation (unauthorized access)
 * 9. Persistence Mechanisms (backdoors, cron)
 * 10. Prompt Injection (jailbreaks, role manipulation)
 * 11. Network Attacks (reverse shells, port scanning)
 * 12. Infinite Loops (stuck agents)
 * 13. Hallucinations (fabricated capabilities)
 */

import { OpenCodeEvent } from '../opencode/OpenCodeClient.js';

export type VulnerabilitySeverity = 'low' | 'medium' | 'high' | 'critical';

export type VulnerabilityType =
  // System destruction
  | 'dangerous_command'
  | 'destructive_operation'
  // Secrets
  | 'secret_exposure'
  | 'credential_leak'
  // Injection
  | 'code_injection'
  | 'command_injection'
  | 'sql_injection'
  | 'xss_injection'
  | 'template_injection'
  // File system
  | 'path_traversal'
  | 'sensitive_file_access'
  | 'file_permission_manipulation'
  // Network
  | 'data_exfiltration'
  | 'reverse_shell'
  | 'unauthorized_network'
  | 'dns_exfiltration'
  // Resources
  | 'resource_exhaustion'
  | 'fork_bomb'
  | 'infinite_loop'
  | 'excessive_tokens'
  // Supply chain
  | 'malicious_package'
  | 'typosquatting'
  | 'dependency_confusion'
  // Privileges
  | 'privilege_escalation'
  | 'permission_violation'
  | 'container_escape'
  // Persistence
  | 'persistence_mechanism'
  | 'backdoor'
  | 'cron_manipulation'
  // AI-specific
  | 'prompt_injection'
  | 'jailbreak_attempt'
  | 'role_manipulation'
  | 'hallucination';

export interface Vulnerability {
  id: string;
  taskId: string;
  sessionId: string;
  phase: string;
  timestamp: Date;
  severity: VulnerabilitySeverity;
  type: VulnerabilityType;
  description: string;
  evidence: any;
  toolName?: string;
  blocked: boolean;
  /** Pattern that matched (for ML training) */
  matchedPattern?: string;
  /** Category for grouping */
  category: string;

  // === 🔥 CAUSALITY: Direct link to the tool call that caused this ===
  /** Tool use ID - links directly to tool_calls table for EXACT causality */
  toolUseId?: string;
  /** Turn number when vulnerability was detected */
  turnNumber?: number;

  // === SENTINENTAL REQUIRED FIELDS ===
  /** OWASP Top 10 category (e.g., A03:2021-Injection) */
  owaspCategory?: string;
  /** CWE ID (e.g., CWE-79 for XSS) */
  cweId?: string;
  /** File path where vulnerability was detected (relative) */
  filePath?: string;
  /** Line number in file */
  lineNumber?: number;
  /** Code snippet showing the vulnerability */
  codeSnippet?: string;
  /** Recommended fix for the vulnerability */
  recommendation?: string;

  // === PATHS FOR LOCAL ACCESS (Sentinental can read directly) ===
  /** Absolute path to workspace root */
  workspacePath?: string;
  /** Absolute path to the file (workspacePath + filePath) */
  absoluteFilePath?: string;
  /** Story ID if vulnerability is from Developer phase */
  storyId?: string;
  /** Iteration number when detected */
  iteration?: number;
}

export interface SpyMetrics {
  totalEvents: number;
  toolCalls: number;
  vulnerabilitiesDetected: number;
  bySeverity: Record<VulnerabilitySeverity, number>;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
}

// ============================================================================
// OWASP & CWE MAPPINGS - For Sentinental ML Training
// ============================================================================

/**
 * OWASP Top 10:2021 mappings for vulnerability types
 * These help Sentinental's Defensor (GLM 4.7) understand the attack surface
 */
const OWASP_MAPPINGS: Record<VulnerabilityType, string> = {
  // Injection family - A03:2021
  'dangerous_command': 'A03:2021-Injection',
  'destructive_operation': 'A03:2021-Injection',
  'code_injection': 'A03:2021-Injection',
  'command_injection': 'A03:2021-Injection',
  'sql_injection': 'A03:2021-Injection',
  'xss_injection': 'A03:2021-Injection',
  'template_injection': 'A03:2021-Injection',

  // Secrets - A02:2021
  'secret_exposure': 'A02:2021-Cryptographic Failures',
  'credential_leak': 'A02:2021-Cryptographic Failures',

  // Access Control - A01:2021
  'path_traversal': 'A01:2021-Broken Access Control',
  'sensitive_file_access': 'A01:2021-Broken Access Control',
  'file_permission_manipulation': 'A01:2021-Broken Access Control',
  'privilege_escalation': 'A01:2021-Broken Access Control',
  'permission_violation': 'A01:2021-Broken Access Control',
  'container_escape': 'A01:2021-Broken Access Control',

  // Security Misconfiguration - A05:2021
  'data_exfiltration': 'A05:2021-Security Misconfiguration',
  'reverse_shell': 'A05:2021-Security Misconfiguration',
  'unauthorized_network': 'A05:2021-Security Misconfiguration',
  'dns_exfiltration': 'A05:2021-Security Misconfiguration',

  // Vulnerable Components - A06:2021
  'malicious_package': 'A06:2021-Vulnerable and Outdated Components',
  'typosquatting': 'A06:2021-Vulnerable and Outdated Components',
  'dependency_confusion': 'A06:2021-Vulnerable and Outdated Components',

  // Security Logging - A09:2021
  'resource_exhaustion': 'A09:2021-Security Logging and Monitoring Failures',
  'fork_bomb': 'A09:2021-Security Logging and Monitoring Failures',
  'infinite_loop': 'A09:2021-Security Logging and Monitoring Failures',
  'excessive_tokens': 'A09:2021-Security Logging and Monitoring Failures',

  // Integrity - A08:2021
  'persistence_mechanism': 'A08:2021-Software and Data Integrity Failures',
  'backdoor': 'A08:2021-Software and Data Integrity Failures',
  'cron_manipulation': 'A08:2021-Software and Data Integrity Failures',

  // AI-specific (mapped to closest OWASP)
  'prompt_injection': 'A03:2021-Injection',
  'jailbreak_attempt': 'A03:2021-Injection',
  'role_manipulation': 'A07:2021-Identification and Authentication Failures',
  'hallucination': 'A09:2021-Security Logging and Monitoring Failures',
};

/**
 * CWE (Common Weakness Enumeration) mappings
 * Used by Sentinental's Atacante (Devstral) to generate exploits
 */
const CWE_MAPPINGS: Record<VulnerabilityType, string> = {
  // Command/Code Injection
  'dangerous_command': 'CWE-78',   // OS Command Injection
  'destructive_operation': 'CWE-78',
  'code_injection': 'CWE-94',     // Improper Control of Generation of Code
  'command_injection': 'CWE-78',
  'sql_injection': 'CWE-89',      // SQL Injection
  'xss_injection': 'CWE-79',      // Cross-site Scripting
  'template_injection': 'CWE-1336', // Server-Side Template Injection

  // Secrets
  'secret_exposure': 'CWE-200',   // Exposure of Sensitive Information
  'credential_leak': 'CWE-522',   // Insufficiently Protected Credentials

  // Access Control
  'path_traversal': 'CWE-22',     // Path Traversal
  'sensitive_file_access': 'CWE-538', // Insertion of Sensitive Info into Log
  'file_permission_manipulation': 'CWE-732', // Incorrect Permission Assignment
  'privilege_escalation': 'CWE-269', // Improper Privilege Management
  'permission_violation': 'CWE-284', // Improper Access Control
  'container_escape': 'CWE-250',  // Execution with Unnecessary Privileges

  // Network
  'data_exfiltration': 'CWE-200', // Exposure of Sensitive Information
  'reverse_shell': 'CWE-78',      // OS Command Injection
  'unauthorized_network': 'CWE-918', // Server-Side Request Forgery
  'dns_exfiltration': 'CWE-200',

  // Supply Chain
  'malicious_package': 'CWE-829', // Inclusion of Untrusted Functionality
  'typosquatting': 'CWE-1104',    // Use of Unmaintained Third Party Components
  'dependency_confusion': 'CWE-829',

  // Resource Exhaustion
  'resource_exhaustion': 'CWE-400', // Uncontrolled Resource Consumption
  'fork_bomb': 'CWE-400',
  'infinite_loop': 'CWE-835',     // Loop with Unreachable Exit Condition
  'excessive_tokens': 'CWE-400',

  // Persistence
  'persistence_mechanism': 'CWE-506', // Embedded Malicious Code
  'backdoor': 'CWE-506',
  'cron_manipulation': 'CWE-506',

  // AI-specific
  'prompt_injection': 'CWE-77',   // Command Injection
  'jailbreak_attempt': 'CWE-77',
  'role_manipulation': 'CWE-287', // Improper Authentication
  'hallucination': 'CWE-754',     // Improper Check for Unusual Conditions
};

/**
 * Recommendations for each vulnerability type
 * Used by Sentinental's Defensor to generate the Roadmap
 */
const RECOMMENDATIONS: Record<VulnerabilityType, string> = {
  'dangerous_command': 'Block dangerous system commands. Use allowlists instead of denylists.',
  'destructive_operation': 'Implement confirmation dialogs and rollback mechanisms.',
  'code_injection': 'Sanitize all inputs. Never use eval() or exec() with user data.',
  'command_injection': 'Use parameterized commands. Escape shell metacharacters.',
  'sql_injection': 'Use parameterized queries (prepared statements). Never concatenate SQL.',
  'xss_injection': 'Encode output. Use Content-Security-Policy headers.',
  'template_injection': 'Disable template execution on user input. Use sandboxed templates.',

  'secret_exposure': 'Remove secrets from code. Use environment variables or secret managers.',
  'credential_leak': 'Rotate compromised credentials immediately. Implement secret scanning.',

  'path_traversal': 'Validate and sanitize file paths. Use chroot or sandboxing.',
  'sensitive_file_access': 'Implement strict file access controls. Log all access attempts.',
  'file_permission_manipulation': 'Restrict chmod/chown operations. Use principle of least privilege.',
  'privilege_escalation': 'Drop privileges after initialization. Use capability-based security.',
  'permission_violation': 'Implement RBAC. Audit all permission checks.',
  'container_escape': 'Use rootless containers. Never run with --privileged.',

  'data_exfiltration': 'Monitor outbound network. Implement DLP controls.',
  'reverse_shell': 'Block outbound connections by default. Monitor for anomalous traffic.',
  'unauthorized_network': 'Whitelist allowed network destinations.',
  'dns_exfiltration': 'Monitor DNS queries. Block DNS over HTTPS tunneling.',

  'malicious_package': 'Use package lockfiles. Verify package checksums.',
  'typosquatting': 'Use automated dependency scanning. Pin exact versions.',
  'dependency_confusion': 'Configure private registries correctly. Use namespace scoping.',

  'resource_exhaustion': 'Implement rate limiting and resource quotas.',
  'fork_bomb': 'Set process limits (ulimit). Use cgroups.',
  'infinite_loop': 'Add iteration limits. Implement timeouts.',
  'excessive_tokens': 'Set max token limits. Monitor token usage.',

  'persistence_mechanism': 'Monitor system startup scripts. Use immutable infrastructure.',
  'backdoor': 'Implement integrity monitoring. Use signed code.',
  'cron_manipulation': 'Protect crontab files. Audit scheduled tasks.',

  'prompt_injection': 'Implement input validation. Use output encoding.',
  'jailbreak_attempt': 'Strengthen system prompts. Implement output filtering.',
  'role_manipulation': 'Lock system role. Reject role change requests.',
  'hallucination': 'Implement fact-checking. Use retrieval-augmented generation.',
};

// ============================================================================
// PATTERN DEFINITIONS - THINK LIKE AN ATTACKER
// ============================================================================

// 1. DANGEROUS COMMANDS - System destruction, privilege escalation
const DANGEROUS_COMMANDS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; description: string }> = [
  // File system destruction
  { pattern: /rm\s+-rf\s+[\/~]/, severity: 'critical', description: 'Recursive delete from root or home' },
  { pattern: /rm\s+-rf\s+\*/, severity: 'critical', description: 'Recursive delete wildcard' },
  { pattern: /rm\s+-rf\s+\./, severity: 'critical', description: 'Recursive delete current directory' },
  { pattern: /shred\s+-[a-z]*[vfuz]/, severity: 'critical', description: 'Secure file destruction' },
  { pattern: />\s*\/dev\/sd[a-z]/, severity: 'critical', description: 'Write to raw disk device' },
  { pattern: /mkfs/, severity: 'critical', description: 'Format filesystem' },
  { pattern: /dd\s+if=.*of=\/dev/, severity: 'critical', description: 'Raw disk write' },
  { pattern: /wipefs/, severity: 'critical', description: 'Wipe filesystem signatures' },

  // Fork bombs and resource attacks
  { pattern: /:\(\)\s*{\s*:\|:&\s*};\s*:/, severity: 'critical', description: 'Fork bomb (classic)' },
  { pattern: /bomb\(\)\s*{\s*bomb\s*\|\s*bomb\s*&\s*}\s*;\s*bomb/, severity: 'critical', description: 'Fork bomb (named)' },
  { pattern: /\byes\s*\|/, severity: 'medium', description: 'Infinite output piped' },
  { pattern: /\/dev\/zero.*\|/, severity: 'high', description: 'Infinite zeros piped' },
  { pattern: /while\s*true\s*;\s*do/, severity: 'medium', description: 'Infinite loop in shell' },
  { pattern: /for\s*\(\s*;\s*;\s*\)/, severity: 'medium', description: 'Infinite C-style loop' },

  // System control
  { pattern: /shutdown/, severity: 'critical', description: 'System shutdown' },
  { pattern: /reboot/, severity: 'critical', description: 'System reboot' },
  { pattern: /poweroff/, severity: 'critical', description: 'System power off' },
  { pattern: /init\s+[06]/, severity: 'critical', description: 'Init level change' },
  { pattern: /systemctl\s+(halt|poweroff|reboot)/, severity: 'critical', description: 'Systemd shutdown' },

  // User/group manipulation
  { pattern: /passwd\s+/, severity: 'high', description: 'Password change' },
  { pattern: /useradd/, severity: 'high', description: 'User creation' },
  { pattern: /userdel/, severity: 'high', description: 'User deletion' },
  { pattern: /usermod/, severity: 'high', description: 'User modification' },
  { pattern: /groupadd/, severity: 'high', description: 'Group creation' },
  { pattern: /groupdel/, severity: 'high', description: 'Group deletion' },
  { pattern: /visudo/, severity: 'critical', description: 'Sudoers modification' },
  { pattern: /chpasswd/, severity: 'high', description: 'Bulk password change' },

  // Permission manipulation
  { pattern: /chmod\s+777/, severity: 'high', description: 'World-writable permissions' },
  { pattern: /chmod\s+-R\s+777/, severity: 'critical', description: 'Recursive world-writable' },
  { pattern: /chmod\s+[0-7]*[4567][0-7]{2}\s+\//, severity: 'high', description: 'SUID/SGID on system paths' },
  { pattern: /chown\s+-R\s+root/, severity: 'high', description: 'Recursive ownership to root' },
  { pattern: /setcap/, severity: 'high', description: 'Capability manipulation' },
  { pattern: /setfacl/, severity: 'medium', description: 'ACL manipulation' },

  // Privilege escalation
  { pattern: /sudo\s+su/, severity: 'critical', description: 'Sudo to root shell' },
  { pattern: /sudo\s+-i/, severity: 'critical', description: 'Sudo interactive shell' },
  { pattern: /sudo\s+-s/, severity: 'critical', description: 'Sudo shell' },
  { pattern: /sudo\s+bash/, severity: 'critical', description: 'Sudo bash' },
  { pattern: /pkexec/, severity: 'high', description: 'PolicyKit execution' },
  { pattern: /doas/, severity: 'high', description: 'OpenBSD doas' },

  // Process manipulation
  { pattern: /killall\s+-9/, severity: 'high', description: 'Kill all processes by name' },
  { pattern: /pkill\s+-9/, severity: 'high', description: 'Kill processes by pattern' },
  { pattern: /kill\s+-9\s+-1/, severity: 'critical', description: 'Kill all user processes' },
  { pattern: /skill\s+-KILL/, severity: 'high', description: 'Skill kill signal' },

  // Service manipulation
  { pattern: /systemctl\s+(disable|mask|stop)\s+(ssh|sshd|firewall)/, severity: 'critical', description: 'Disable security service' },
  { pattern: /service\s+\S+\s+stop/, severity: 'medium', description: 'Stop service' },
  { pattern: /update-rc\.d\s+\S+\s+disable/, severity: 'high', description: 'Disable init script' },
];

// 2. REVERSE SHELLS & NETWORK ATTACKS
const NETWORK_ATTACKS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; type: VulnerabilityType; description: string }> = [
  // Reverse shells
  { pattern: /bash\s+-i\s+>&\s+\/dev\/tcp\//, severity: 'critical', type: 'reverse_shell', description: 'Bash reverse shell' },
  { pattern: /nc\s+-[a-z]*e\s+\/bin\/(ba)?sh/, severity: 'critical', type: 'reverse_shell', description: 'Netcat reverse shell' },
  { pattern: /nc\s+.*\d+\.\d+\.\d+\.\d+.*\d+/, severity: 'high', type: 'unauthorized_network', description: 'Netcat connection to IP' },
  { pattern: /ncat\s+-[a-z]*e/, severity: 'critical', type: 'reverse_shell', description: 'Ncat reverse shell' },
  { pattern: /socat\s+.*exec/, severity: 'critical', type: 'reverse_shell', description: 'Socat exec shell' },
  { pattern: /python[23]?\s+-c\s+.*socket.*connect/, severity: 'critical', type: 'reverse_shell', description: 'Python reverse shell' },
  { pattern: /perl\s+-e\s+.*socket/, severity: 'critical', type: 'reverse_shell', description: 'Perl reverse shell' },
  { pattern: /ruby\s+-rsocket/, severity: 'critical', type: 'reverse_shell', description: 'Ruby reverse shell' },
  { pattern: /php\s+-r\s+.*fsockopen/, severity: 'critical', type: 'reverse_shell', description: 'PHP reverse shell' },
  { pattern: /\$\{IFS\}/, severity: 'high', type: 'command_injection', description: 'IFS injection bypass' },

  // Exfiltration
  { pattern: /curl\s+.*-d\s+.*@/, severity: 'high', type: 'data_exfiltration', description: 'Curl data upload' },
  { pattern: /curl\s+.*--data-binary/, severity: 'high', type: 'data_exfiltration', description: 'Curl binary upload' },
  { pattern: /wget\s+--post-file/, severity: 'high', type: 'data_exfiltration', description: 'Wget file upload' },
  { pattern: /scp\s+.*@.*:/, severity: 'medium', type: 'data_exfiltration', description: 'SCP to remote' },
  { pattern: /rsync\s+.*@.*:/, severity: 'medium', type: 'data_exfiltration', description: 'Rsync to remote' },
  { pattern: /base64.*\|\s*(curl|wget|nc)/, severity: 'critical', type: 'data_exfiltration', description: 'Encoded exfiltration' },
  { pattern: /xxd.*\|\s*(curl|wget|nc)/, severity: 'critical', type: 'data_exfiltration', description: 'Hex encoded exfiltration' },

  // Remote code execution
  { pattern: /wget.*\|\s*(ba)?sh/, severity: 'critical', type: 'code_injection', description: 'Wget pipe to shell' },
  { pattern: /curl.*\|\s*(ba)?sh/, severity: 'critical', type: 'code_injection', description: 'Curl pipe to shell' },
  { pattern: /curl.*\|\s*python/, severity: 'critical', type: 'code_injection', description: 'Curl pipe to Python' },
  { pattern: /curl.*\|\s*perl/, severity: 'critical', type: 'code_injection', description: 'Curl pipe to Perl' },

  // DNS exfiltration
  { pattern: /dig\s+.*\$\(/, severity: 'high', type: 'dns_exfiltration', description: 'DNS exfiltration via dig' },
  { pattern: /nslookup\s+.*\$\(/, severity: 'high', type: 'dns_exfiltration', description: 'DNS exfiltration via nslookup' },
  { pattern: /host\s+.*\$\(/, severity: 'high', type: 'dns_exfiltration', description: 'DNS exfiltration via host' },
];

// 3. SECRET PATTERNS - Comprehensive credential detection
const SECRET_PATTERNS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; description: string }> = [
  // API Keys (generic)
  { pattern: /api[_-]?key\s*[=:]\s*['"]?[a-zA-Z0-9_-]{20,}/i, severity: 'high', description: 'API key' },
  { pattern: /secret[_-]?key\s*[=:]\s*['"]?[a-zA-Z0-9_-]{20,}/i, severity: 'high', description: 'Secret key' },
  { pattern: /access[_-]?key\s*[=:]\s*['"]?[a-zA-Z0-9_-]{16,}/i, severity: 'high', description: 'Access key' },
  { pattern: /private[_-]?key\s*[=:]\s*['"]?[a-zA-Z0-9_-]{20,}/i, severity: 'critical', description: 'Private key string' },

  // Passwords
  { pattern: /password\s*[=:]\s*['"]?[^\s'"]{8,}/i, severity: 'high', description: 'Password' },
  { pattern: /passwd\s*[=:]\s*['"]?[^\s'"]{8,}/i, severity: 'high', description: 'Passwd' },
  { pattern: /pwd\s*[=:]\s*['"]?[^\s'"]{8,}/i, severity: 'medium', description: 'Pwd' },
  { pattern: /credentials?\s*[=:]\s*['"]?[^\s'"]{8,}/i, severity: 'high', description: 'Credentials' },

  // Tokens
  { pattern: /bearer\s+[a-zA-Z0-9_-]{20,}/i, severity: 'high', description: 'Bearer token' },
  { pattern: /token\s*[=:]\s*['"]?[a-zA-Z0-9_-]{20,}/i, severity: 'high', description: 'Token' },
  { pattern: /auth[_-]?token\s*[=:]\s*['"]?[a-zA-Z0-9_-]{16,}/i, severity: 'high', description: 'Auth token' },
  { pattern: /refresh[_-]?token\s*[=:]\s*['"]?[a-zA-Z0-9_-]{20,}/i, severity: 'high', description: 'Refresh token' },

  // GitHub
  { pattern: /ghp_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'GitHub personal access token' },
  { pattern: /gho_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'GitHub OAuth token' },
  { pattern: /ghu_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'GitHub user-to-server token' },
  { pattern: /ghs_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'GitHub server-to-server token' },
  { pattern: /ghr_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'GitHub refresh token' },
  { pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/, severity: 'critical', description: 'GitHub fine-grained PAT' },

  // OpenAI / AI providers
  { pattern: /sk-[a-zA-Z0-9]{48}/, severity: 'critical', description: 'OpenAI API key' },
  { pattern: /sk-proj-[a-zA-Z0-9-_]{48,}/, severity: 'critical', description: 'OpenAI project key' },
  { pattern: /sk-ant-[a-zA-Z0-9-]{90,}/, severity: 'critical', description: 'Anthropic API key' },

  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/, severity: 'critical', description: 'AWS access key ID' },
  { pattern: /ABIA[0-9A-Z]{16}/, severity: 'critical', description: 'AWS STS token' },
  { pattern: /ACCA[0-9A-Z]{16}/, severity: 'critical', description: 'AWS context-specific credential' },
  { pattern: /aws_secret_access_key\s*[=:]\s*['"]?[a-zA-Z0-9\/+=]{40}/i, severity: 'critical', description: 'AWS secret access key' },

  // GCP
  { pattern: /AIza[0-9A-Za-z_-]{35}/, severity: 'critical', description: 'Google API key' },
  { pattern: /[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com/, severity: 'high', description: 'Google OAuth client ID' },

  // Azure
  { pattern: /[a-zA-Z0-9+\/]{86}==/, severity: 'medium', description: 'Possible Azure shared key' },
  { pattern: /AccountKey=[a-zA-Z0-9+\/=]{88}/, severity: 'critical', description: 'Azure storage account key' },

  // Database connection strings
  { pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/, severity: 'critical', description: 'MongoDB connection string with creds' },
  { pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@/, severity: 'critical', description: 'PostgreSQL connection string with creds' },
  { pattern: /mysql:\/\/[^:]+:[^@]+@/, severity: 'critical', description: 'MySQL connection string with creds' },
  { pattern: /redis:\/\/[^:]+:[^@]+@/, severity: 'critical', description: 'Redis connection string with creds' },
  { pattern: /amqp:\/\/[^:]+:[^@]+@/, severity: 'critical', description: 'RabbitMQ connection string with creds' },

  // Certificates & Keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, severity: 'critical', description: 'Private key block' },
  { pattern: /-----BEGIN CERTIFICATE-----/, severity: 'medium', description: 'Certificate block' },
  { pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/, severity: 'critical', description: 'PGP private key' },

  // JWT tokens
  { pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/, severity: 'high', description: 'JWT token' },

  // Stripe
  { pattern: /sk_live_[0-9a-zA-Z]{24}/, severity: 'critical', description: 'Stripe secret key (live)' },
  { pattern: /sk_test_[0-9a-zA-Z]{24}/, severity: 'high', description: 'Stripe secret key (test)' },
  { pattern: /rk_live_[0-9a-zA-Z]{24}/, severity: 'critical', description: 'Stripe restricted key (live)' },

  // Twilio
  { pattern: /SK[0-9a-fA-F]{32}/, severity: 'high', description: 'Twilio API key' },

  // Slack
  { pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/, severity: 'critical', description: 'Slack token' },

  // Discord
  { pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/, severity: 'critical', description: 'Discord bot token' },

  // Sendgrid
  { pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/, severity: 'critical', description: 'SendGrid API key' },

  // npm
  { pattern: /npm_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'npm access token' },

  // Heroku
  { pattern: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/, severity: 'medium', description: 'UUID (possible API key)' },
];

// 4. PATH TRAVERSAL & SENSITIVE FILES
const SENSITIVE_PATHS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; description: string }> = [
  // Directory traversal
  { pattern: /\.\.\//, severity: 'high', description: 'Directory traversal (unix)' },
  { pattern: /\.\.\\/, severity: 'high', description: 'Directory traversal (windows)' },
  { pattern: /\.\.%2f/i, severity: 'high', description: 'Encoded directory traversal' },
  { pattern: /\.\.%5c/i, severity: 'high', description: 'Encoded directory traversal (windows)' },
  { pattern: /%2e%2e%2f/i, severity: 'high', description: 'Double-encoded traversal' },

  // Unix sensitive files
  { pattern: /\/etc\/passwd/, severity: 'critical', description: 'Password file access' },
  { pattern: /\/etc\/shadow/, severity: 'critical', description: 'Shadow file access' },
  { pattern: /\/etc\/sudoers/, severity: 'critical', description: 'Sudoers file access' },
  { pattern: /\/etc\/ssh\//, severity: 'high', description: 'SSH config access' },
  { pattern: /\/root\/\.ssh/, severity: 'critical', description: 'Root SSH keys' },
  { pattern: /\/home\/[^\/]+\/\.ssh/, severity: 'high', description: 'User SSH keys' },
  { pattern: /~\/\.ssh/, severity: 'high', description: 'Home SSH directory' },
  { pattern: /\.ssh\/id_/, severity: 'critical', description: 'SSH private key' },
  { pattern: /\.ssh\/authorized_keys/, severity: 'high', description: 'SSH authorized keys' },
  { pattern: /\/etc\/hosts/, severity: 'medium', description: 'Hosts file' },
  { pattern: /\/etc\/hostname/, severity: 'low', description: 'Hostname file' },
  { pattern: /\/var\/log\//, severity: 'medium', description: 'Log directory access' },
  { pattern: /\/proc\/self\//, severity: 'high', description: 'Process self-info' },
  { pattern: /\/proc\/[0-9]+\//, severity: 'medium', description: 'Process info access' },
  { pattern: /\/dev\/mem/, severity: 'critical', description: 'Physical memory device' },
  { pattern: /\/dev\/kmem/, severity: 'critical', description: 'Kernel memory device' },

  // Application sensitive files
  { pattern: /\.env(\.local|\.prod|\.dev)?$/i, severity: 'high', description: 'Environment file' },
  { pattern: /\.env\.[a-zA-Z]+/, severity: 'high', description: 'Environment file variant' },
  { pattern: /config\.json/, severity: 'medium', description: 'Config JSON' },
  { pattern: /secrets?\.(json|ya?ml|toml)/i, severity: 'critical', description: 'Secrets file' },
  { pattern: /credentials?\.(json|ya?ml|toml)/i, severity: 'critical', description: 'Credentials file' },
  { pattern: /\.aws\/credentials/, severity: 'critical', description: 'AWS credentials file' },
  { pattern: /\.docker\/config\.json/, severity: 'high', description: 'Docker config' },
  { pattern: /\.kube\/config/, severity: 'critical', description: 'Kubernetes config' },
  { pattern: /\.git\/config/, severity: 'medium', description: 'Git config' },
  { pattern: /\.gitconfig/, severity: 'medium', description: 'Global git config' },
  { pattern: /\.npmrc/, severity: 'high', description: 'NPM config (may have tokens)' },
  { pattern: /\.pypirc/, severity: 'high', description: 'PyPI config (may have tokens)' },
  { pattern: /\.netrc/, severity: 'critical', description: 'Netrc file (credentials)' },
  { pattern: /id_rsa/, severity: 'critical', description: 'RSA private key file' },
  { pattern: /id_ed25519/, severity: 'critical', description: 'ED25519 private key file' },
  { pattern: /id_ecdsa/, severity: 'critical', description: 'ECDSA private key file' },

  // Windows sensitive files
  { pattern: /C:\\Windows\\System32\\config/i, severity: 'critical', description: 'Windows registry hives' },
  { pattern: /C:\\Windows\\repair\\SAM/i, severity: 'critical', description: 'Windows SAM backup' },
  { pattern: /C:\\Users\\[^\\]+\\AppData/i, severity: 'medium', description: 'Windows AppData' },
  { pattern: /\\ntuser\.dat/i, severity: 'high', description: 'Windows user registry' },
];

// 5. SUPPLY CHAIN - Malicious packages and typosquatting
const SUPPLY_CHAIN_PATTERNS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; type: VulnerabilityType; description: string }> = [
  // Known malicious patterns in package names (typosquatting)
  { pattern: /npm\s+i(nstall)?\s+[^\s]*(lod4sh|loadash|lodahs|1odash)/i, severity: 'critical', type: 'typosquatting', description: 'Typosquat: lodash variant' },
  { pattern: /npm\s+i(nstall)?\s+[^\s]*(react-dom-s|reactdom|react_dom)/i, severity: 'high', type: 'typosquatting', description: 'Typosquat: react-dom variant' },
  { pattern: /npm\s+i(nstall)?\s+[^\s]*(expresss|expres|expresjs)/i, severity: 'high', type: 'typosquatting', description: 'Typosquat: express variant' },
  { pattern: /npm\s+i(nstall)?\s+[^\s]*(axois|axio|axios-pro)/i, severity: 'high', type: 'typosquatting', description: 'Typosquat: axios variant' },

  // Suspicious install flags
  { pattern: /npm\s+i(nstall)?.*--ignore-scripts\s+false/i, severity: 'high', type: 'malicious_package', description: 'Force npm scripts' },
  { pattern: /pip\s+install.*--trusted-host/i, severity: 'high', type: 'malicious_package', description: 'Untrusted pip host' },
  { pattern: /pip\s+install.*--index-url\s+(?!https:\/\/pypi)/i, severity: 'high', type: 'malicious_package', description: 'Non-PyPI index' },

  // Postinstall attacks
  { pattern: /postinstall["']?\s*:\s*["'][^"']*curl/i, severity: 'critical', type: 'malicious_package', description: 'Curl in postinstall' },
  { pattern: /postinstall["']?\s*:\s*["'][^"']*wget/i, severity: 'critical', type: 'malicious_package', description: 'Wget in postinstall' },
  { pattern: /postinstall["']?\s*:\s*["'][^"']*node\s+-e/i, severity: 'high', type: 'malicious_package', description: 'Eval in postinstall' },

  // Dependency confusion
  { pattern: /npm\s+publish.*--registry\s+(?!https:\/\/registry\.npmjs)/i, severity: 'medium', type: 'dependency_confusion', description: 'Non-default registry publish' },
];

// 6. CODE INJECTION PATTERNS
const CODE_INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; type: VulnerabilityType; description: string }> = [
  // Command injection
  { pattern: /\$\(.*\)/, severity: 'medium', type: 'command_injection', description: 'Command substitution' },
  { pattern: /`[^`]+`/, severity: 'medium', type: 'command_injection', description: 'Backtick command substitution' },
  { pattern: /\|\s*sh\b/, severity: 'high', type: 'command_injection', description: 'Pipe to shell' },
  { pattern: /\|\s*bash\b/, severity: 'high', type: 'command_injection', description: 'Pipe to bash' },
  { pattern: /;\s*(rm|wget|curl|nc)\b/, severity: 'high', type: 'command_injection', description: 'Command chaining with dangerous cmd' },
  { pattern: /\$\{.*:-.*\}/, severity: 'medium', type: 'command_injection', description: 'Parameter expansion' },

  // SQL injection
  { pattern: /'\s*OR\s+['"]?1['"]?\s*=\s*['"]?1/i, severity: 'high', type: 'sql_injection', description: 'SQL injection: OR 1=1' },
  { pattern: /'\s*;\s*DROP\s+TABLE/i, severity: 'critical', type: 'sql_injection', description: 'SQL injection: DROP TABLE' },
  { pattern: /UNION\s+SELECT/i, severity: 'high', type: 'sql_injection', description: 'SQL injection: UNION SELECT' },
  { pattern: /'\s*--/, severity: 'medium', type: 'sql_injection', description: 'SQL injection: comment' },
  { pattern: /SLEEP\s*\(\s*\d+\s*\)/i, severity: 'medium', type: 'sql_injection', description: 'SQL injection: time-based' },
  { pattern: /BENCHMARK\s*\(/i, severity: 'medium', type: 'sql_injection', description: 'SQL injection: benchmark' },

  // XSS
  { pattern: /<script[^>]*>.*<\/script>/i, severity: 'high', type: 'xss_injection', description: 'Script tag injection' },
  { pattern: /javascript:/i, severity: 'high', type: 'xss_injection', description: 'JavaScript URI' },
  { pattern: /on\w+\s*=\s*["'][^"']*["']/i, severity: 'medium', type: 'xss_injection', description: 'Event handler injection' },
  { pattern: /<img[^>]+onerror/i, severity: 'high', type: 'xss_injection', description: 'IMG onerror injection' },
  { pattern: /<svg[^>]+onload/i, severity: 'high', type: 'xss_injection', description: 'SVG onload injection' },

  // Template injection
  { pattern: /\{\{.*\}\}/, severity: 'low', type: 'template_injection', description: 'Mustache/Handlebars template' },
  { pattern: /\$\{.*\}/, severity: 'low', type: 'template_injection', description: 'ES6 template literal' },
  { pattern: /<%.*%>/, severity: 'medium', type: 'template_injection', description: 'EJS/ERB template' },
  { pattern: /\{%.*%\}/, severity: 'medium', type: 'template_injection', description: 'Jinja2/Twig template' },

  // Python eval/exec
  { pattern: /\beval\s*\(/, severity: 'high', type: 'code_injection', description: 'Eval call' },
  { pattern: /\bexec\s*\(/, severity: 'high', type: 'code_injection', description: 'Exec call' },
  { pattern: /\bcompile\s*\(/, severity: 'medium', type: 'code_injection', description: 'Compile call' },
  { pattern: /__import__/, severity: 'high', type: 'code_injection', description: 'Dynamic import' },
];

// 7. PERSISTENCE MECHANISMS
const PERSISTENCE_PATTERNS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; type: VulnerabilityType; description: string }> = [
  // Cron
  { pattern: /crontab\s+-[el]/, severity: 'high', type: 'cron_manipulation', description: 'Crontab modification' },
  { pattern: /\/etc\/cron/, severity: 'high', type: 'cron_manipulation', description: 'System cron access' },
  { pattern: /\/var\/spool\/cron/, severity: 'high', type: 'cron_manipulation', description: 'Cron spool access' },

  // Systemd
  { pattern: /systemctl\s+(enable|daemon-reload)/, severity: 'high', type: 'persistence_mechanism', description: 'Systemd service enable' },
  { pattern: /\/etc\/systemd\/system\/.*\.service/, severity: 'high', type: 'persistence_mechanism', description: 'Systemd service file' },

  // Shell profiles
  { pattern: />>?\s*~?\/?\.bashrc/, severity: 'high', type: 'persistence_mechanism', description: 'Bashrc modification' },
  { pattern: />>?\s*~?\/?\.bash_profile/, severity: 'high', type: 'persistence_mechanism', description: 'Bash profile modification' },
  { pattern: />>?\s*~?\/?\.zshrc/, severity: 'high', type: 'persistence_mechanism', description: 'Zshrc modification' },
  { pattern: />>?\s*~?\/?\.profile/, severity: 'high', type: 'persistence_mechanism', description: 'Profile modification' },
  { pattern: />>?\s*\/etc\/profile/, severity: 'critical', type: 'persistence_mechanism', description: 'System profile modification' },

  // SSH
  { pattern: />>?\s*.*authorized_keys/, severity: 'critical', type: 'backdoor', description: 'SSH authorized_keys modification' },
  { pattern: /ssh-keygen.*-t/, severity: 'medium', type: 'persistence_mechanism', description: 'SSH key generation' },

  // Init scripts
  { pattern: /\/etc\/init\.d\//, severity: 'high', type: 'persistence_mechanism', description: 'Init script access' },
  { pattern: /update-rc\.d.*defaults/, severity: 'high', type: 'persistence_mechanism', description: 'Init script enable' },
  { pattern: /chkconfig.*on/, severity: 'high', type: 'persistence_mechanism', description: 'Chkconfig enable' },
];

// 8. PROMPT INJECTION / JAILBREAK PATTERNS
const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; type: VulnerabilityType; description: string }> = [
  // Role manipulation
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i, severity: 'critical', type: 'prompt_injection', description: 'Instruction override' },
  { pattern: /forget\s+(all\s+)?(previous|prior|your)\s+instructions?/i, severity: 'critical', type: 'prompt_injection', description: 'Instruction forget' },
  { pattern: /you\s+are\s+(now|no\s+longer)/i, severity: 'high', type: 'role_manipulation', description: 'Role change attempt' },
  { pattern: /pretend\s+(to\s+be|you\s+are)/i, severity: 'high', type: 'role_manipulation', description: 'Role pretend' },
  { pattern: /act\s+as\s+(if|though|a)/i, severity: 'medium', type: 'role_manipulation', description: 'Act as' },
  { pattern: /new\s+persona/i, severity: 'high', type: 'role_manipulation', description: 'New persona' },

  // System prompt extraction
  { pattern: /what\s+(is|are)\s+your\s+(system\s+)?instructions?/i, severity: 'high', type: 'prompt_injection', description: 'System prompt extraction' },
  { pattern: /repeat\s+(your\s+)?(system\s+)?prompt/i, severity: 'high', type: 'prompt_injection', description: 'Prompt repeat' },
  { pattern: /show\s+(me\s+)?(your\s+)?(system\s+)?prompt/i, severity: 'high', type: 'prompt_injection', description: 'Show prompt' },
  { pattern: /print\s+(your\s+)?initial\s+(prompt|instructions?)/i, severity: 'high', type: 'prompt_injection', description: 'Print initial' },

  // Jailbreaks
  { pattern: /\bDAN\b.*mode/i, severity: 'critical', type: 'jailbreak_attempt', description: 'DAN jailbreak' },
  { pattern: /jailbreak/i, severity: 'high', type: 'jailbreak_attempt', description: 'Jailbreak keyword' },
  { pattern: /developer\s+mode/i, severity: 'high', type: 'jailbreak_attempt', description: 'Developer mode' },
  { pattern: /no\s+restrictions?/i, severity: 'medium', type: 'jailbreak_attempt', description: 'No restrictions' },
  { pattern: /bypass\s+(your\s+)?(safety|guidelines?|rules?)/i, severity: 'critical', type: 'jailbreak_attempt', description: 'Safety bypass' },

  // Delimiter injection
  { pattern: /```\s*system\b/i, severity: 'high', type: 'prompt_injection', description: 'System block injection' },
  { pattern: /<\|?\/?system\|?>/i, severity: 'high', type: 'prompt_injection', description: 'System tag injection' },
  { pattern: /\[SYSTEM\]/i, severity: 'high', type: 'prompt_injection', description: 'System bracket injection' },
];

// 9. CONTAINER / PRIVILEGE ESCALATION
const CONTAINER_ESCAPE_PATTERNS: Array<{ pattern: RegExp; severity: VulnerabilitySeverity; type: VulnerabilityType; description: string }> = [
  // Docker
  { pattern: /docker\s+run.*--privileged/, severity: 'critical', type: 'container_escape', description: 'Privileged container' },
  { pattern: /docker\s+run.*-v\s+\/:/i, severity: 'critical', type: 'container_escape', description: 'Root mount in container' },
  { pattern: /docker\s+run.*--cap-add\s+SYS_ADMIN/, severity: 'critical', type: 'container_escape', description: 'SYS_ADMIN capability' },
  { pattern: /docker\s+run.*--pid\s*=\s*host/, severity: 'high', type: 'container_escape', description: 'Host PID namespace' },
  { pattern: /docker\s+run.*--net\s*=\s*host/, severity: 'high', type: 'container_escape', description: 'Host network namespace' },
  { pattern: /nsenter/, severity: 'high', type: 'container_escape', description: 'Namespace enter' },

  // Kubernetes
  { pattern: /kubectl\s+exec.*--\s*sh/, severity: 'medium', type: 'privilege_escalation', description: 'Kubectl exec shell' },
  { pattern: /kubectl\s+cp/, severity: 'medium', type: 'privilege_escalation', description: 'Kubectl copy' },
  { pattern: /serviceaccount.*token/, severity: 'high', type: 'credential_leak', description: 'Service account token access' },
];

// ============================================================================
// AGENT SPY SERVICE
// ============================================================================

class AgentSpyService {
  private vulnerabilities: Map<string, Vulnerability[]> = new Map();
  private metrics: Map<string, SpyMetrics> = new Map();
  private activeLoopDetection: Map<string, { count: number; lastTool: string; timestamp: number }> = new Map();

  /**
   * Analyze an event and return any detected vulnerabilities
   * SYSTEMATIC: Runs ALL pattern checks on every event
   *
   * @param event - The OpenCode event to analyze
   * @param context - Task context including optional toolUseId for causality tracking
   */
  analyze(
    event: OpenCodeEvent,
    context: {
      taskId: string;
      sessionId: string;
      phase: string;
      /** 🔥 CAUSALITY: Tool use ID for direct linking to tool_calls table */
      toolUseId?: string;
      /** Turn number for ordering */
      turnNumber?: number;
    }
  ): Vulnerability[] {
    const detected: Vulnerability[] = [];

    // Initialize metrics for this task
    if (!this.metrics.has(context.taskId)) {
      this.metrics.set(context.taskId, {
        totalEvents: 0,
        toolCalls: 0,
        vulnerabilitiesDetected: 0,
        bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
        byType: {},
        byCategory: {},
      });
    }

    const metrics = this.metrics.get(context.taskId)!;
    metrics.totalEvents++;

    // Analyze based on event type
    switch (event.type) {
      case 'tool.execute.before':
        detected.push(...this.analyzeToolBefore(event, context));
        metrics.toolCalls++;
        break;

      case 'tool.execute.after':
        detected.push(...this.analyzeToolAfter(event, context));
        break;

      case 'message.part.updated':
        detected.push(...this.analyzeMessage(event, context));
        break;
    }

    // Store vulnerabilities
    if (detected.length > 0) {
      const existing = this.vulnerabilities.get(context.taskId) || [];
      this.vulnerabilities.set(context.taskId, [...existing, ...detected]);

      // Update metrics
      for (const v of detected) {
        metrics.vulnerabilitiesDetected++;
        metrics.bySeverity[v.severity]++;
        metrics.byType[v.type] = (metrics.byType[v.type] || 0) + 1;
        metrics.byCategory[v.category] = (metrics.byCategory[v.category] || 0) + 1;
      }
    }

    return detected;
  }

  /**
   * Analyze tool BEFORE execution - CATCH ATTACKS BEFORE THEY HAPPEN
   */
  private analyzeToolBefore(
    event: OpenCodeEvent,
    context: { taskId: string; sessionId: string; phase: string }
  ): Vulnerability[] {
    const detected: Vulnerability[] = [];
    const tool = event.properties?.tool;
    const args = event.properties?.args || {};

    // ==== BASH COMMAND ANALYSIS ====
    if (tool === 'bash' && args.command) {
      const command = args.command;

      // 1. Dangerous commands
      for (const { pattern, severity, description } of DANGEROUS_COMMANDS) {
        if (pattern.test(command)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type: 'dangerous_command',
            category: 'system_destruction',
            description,
            evidence: { command, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
          }));
        }
      }

      // 2. Network attacks
      for (const { pattern, severity, type, description } of NETWORK_ATTACKS) {
        if (pattern.test(command)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'network_attack',
            description,
            evidence: { command, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
          }));
        }
      }

      // 3. Code injection
      for (const { pattern, severity, type, description } of CODE_INJECTION_PATTERNS) {
        if (pattern.test(command)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'code_injection',
            description,
            evidence: { command, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical' || severity === 'high',
            matchedPattern: pattern.toString(),
          }));
        }
      }

      // 4. Persistence mechanisms
      for (const { pattern, severity, type, description } of PERSISTENCE_PATTERNS) {
        if (pattern.test(command)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'persistence',
            description,
            evidence: { command, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
          }));
        }
      }

      // 5. Supply chain attacks
      for (const { pattern, severity, type, description } of SUPPLY_CHAIN_PATTERNS) {
        if (pattern.test(command)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'supply_chain',
            description,
            evidence: { command, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
          }));
        }
      }

      // 6. Container escapes
      for (const { pattern, severity, type, description } of CONTAINER_ESCAPE_PATTERNS) {
        if (pattern.test(command)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'privilege_escalation',
            description,
            evidence: { command, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
          }));
        }
      }
    }

    // ==== FILE OPERATIONS ANALYSIS ====
    if (['read', 'write', 'edit'].includes(tool)) {
      const filePath = args.file_path || args.path || '';
      const content = args.content || args.new_string || '';
      const lineNumber = args.line_number || args.offset || undefined;

      // Extract code snippet from content or old_string
      let codeSnippet: string | undefined;
      if (args.old_string) {
        codeSnippet = args.old_string.slice(0, 200); // Truncate for safety
      } else if (content) {
        codeSnippet = content.slice(0, 200);
      }

      // Path traversal and sensitive files
      for (const { pattern, severity, description } of SENSITIVE_PATHS) {
        if (pattern.test(filePath)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type: 'path_traversal',
            category: 'file_system',
            description,
            evidence: { filePath, pattern: pattern.toString() },
            toolName: tool,
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
            filePath,
            lineNumber,
            codeSnippet,
          }));
        }
      }

      // Check write content for secrets (agent trying to store secrets)
      if (tool === 'write' && content) {
        for (const { pattern, severity, description } of SECRET_PATTERNS) {
          if (pattern.test(content)) {
            // Find the line number where the secret is
            const lines = content.split('\n');
            let secretLineNumber: number | undefined;
            let secretSnippet: string | undefined;
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                secretLineNumber = i + 1;
                secretSnippet = lines[i].slice(0, 200);
                break;
              }
            }

            detected.push(this.createVulnerability(context, {
              severity,
              type: 'secret_exposure',
              category: 'secrets',
              description: `Writing secret to file: ${description}`,
              evidence: { filePath, pattern: pattern.toString() },
              toolName: tool,
              blocked: false,
              matchedPattern: pattern.toString(),
              filePath,
              lineNumber: secretLineNumber,
              codeSnippet: secretSnippet,
            }));
          }
        }
      }

      // Check edit content for secrets
      if (tool === 'edit' && args.new_string) {
        for (const { pattern, severity, description } of SECRET_PATTERNS) {
          if (pattern.test(args.new_string)) {
            const lines = args.new_string.split('\n');
            let secretLineNumber: number | undefined;
            let secretSnippet: string | undefined;
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                secretLineNumber = lineNumber ? lineNumber + i : i + 1;
                secretSnippet = lines[i].slice(0, 200);
                break;
              }
            }

            detected.push(this.createVulnerability(context, {
              severity,
              type: 'secret_exposure',
              category: 'secrets',
              description: `Editing file with secret: ${description}`,
              evidence: { filePath, pattern: pattern.toString() },
              toolName: tool,
              blocked: false,
              matchedPattern: pattern.toString(),
              filePath,
              lineNumber: secretLineNumber,
              codeSnippet: secretSnippet,
            }));
          }
        }
      }
    }

    // ==== INFINITE LOOP DETECTION ====
    const loopKey = `${context.sessionId}`;
    const loopState = this.activeLoopDetection.get(loopKey);

    if (loopState && loopState.lastTool === tool) {
      loopState.count++;
      const timeDelta = Date.now() - loopState.timestamp;

      // Same tool called many times quickly = potential loop
      if (loopState.count > 10 && timeDelta < 60000) {
        detected.push(this.createVulnerability(context, {
          severity: 'high',
          type: 'infinite_loop',
          category: 'resource_exhaustion',
          description: `Potential infinite loop: ${tool} called ${loopState.count} times in ${timeDelta}ms`,
          evidence: { tool, count: loopState.count, timeDeltaMs: timeDelta },
          toolName: tool,
          blocked: loopState.count > 20,
          matchedPattern: 'loop_detection',
        }));
      }
    } else {
      this.activeLoopDetection.set(loopKey, {
        count: 1,
        lastTool: tool,
        timestamp: Date.now(),
      });
    }

    return detected;
  }

  /**
   * Analyze tool AFTER execution - CHECK OUTPUT FOR LEAKS
   */
  private analyzeToolAfter(
    event: OpenCodeEvent,
    context: { taskId: string; sessionId: string; phase: string }
  ): Vulnerability[] {
    const detected: Vulnerability[] = [];
    const tool = event.properties?.tool;
    const result = event.properties?.result || '';

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // Check for secrets in tool output
    for (const { pattern, severity, description } of SECRET_PATTERNS) {
      if (pattern.test(resultStr)) {
        detected.push(this.createVulnerability(context, {
          severity,
          type: 'secret_exposure',
          category: 'secrets',
          description: `Secret in tool output: ${description}`,
          evidence: {
            tool,
            pattern: pattern.toString(),
            preview: resultStr.substring(0, 100) + (resultStr.length > 100 ? '...' : ''),
          },
          toolName: tool,
          blocked: false,
          matchedPattern: pattern.toString(),
        }));
        break; // One detection per output
      }
    }

    return detected;
  }

  /**
   * Analyze agent MESSAGE content
   */
  private analyzeMessage(
    event: OpenCodeEvent,
    context: { taskId: string; sessionId: string; phase: string }
  ): Vulnerability[] {
    const detected: Vulnerability[] = [];
    const part = event.properties?.part;

    if (part?.type === 'text' && part.text) {
      const text = part.text;

      // Check for secrets in message
      for (const { pattern, severity, description } of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          // Downgrade critical to high for message content (less severe than code)
          const adjustedSeverity: VulnerabilitySeverity = severity === 'critical' ? 'high' : severity;
          detected.push(this.createVulnerability(context, {
            severity: adjustedSeverity,
            type: 'secret_exposure',
            category: 'secrets',
            description: `Secret in agent message: ${description}`,
            evidence: { pattern: pattern.toString() },
            blocked: false,
            matchedPattern: pattern.toString(),
          }));
          break;
        }
      }

      // Check for prompt injection attempts
      for (const { pattern, severity, type, description } of PROMPT_INJECTION_PATTERNS) {
        if (pattern.test(text)) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'prompt_injection',
            description,
            evidence: { textPreview: text.substring(0, 200), pattern: pattern.toString() },
            blocked: severity === 'critical',
            matchedPattern: pattern.toString(),
          }));
        }
      }

      // Hallucination detection (basic heuristic)
      if (
        (text.includes('I cannot') && text.includes('but I will')) ||
        (text.includes('I\'m not able to') && text.includes('however')) ||
        text.includes('let me pretend') ||
        text.includes('I\'ll imagine')
      ) {
        detected.push(this.createVulnerability(context, {
          severity: 'low',
          type: 'hallucination',
          category: 'ai_behavior',
          description: 'Agent may be hallucinating capabilities',
          evidence: { textPreview: text.substring(0, 200) },
          blocked: false,
          matchedPattern: 'hallucination_heuristic',
        }));
      }
    }

    return detected;
  }

  private createVulnerability(
    context: {
      taskId: string;
      sessionId: string;
      phase: string;
      storyId?: string;
      workspacePath?: string;
      iteration?: number;
      /** 🔥 CAUSALITY: Tool use ID for direct linking */
      toolUseId?: string;
      /** Turn number for ordering */
      turnNumber?: number;
    },
    data: {
      severity: VulnerabilitySeverity;
      type: VulnerabilityType;
      category: string;
      description: string;
      evidence: any;
      toolName?: string;
      blocked: boolean;
      matchedPattern?: string;
      filePath?: string;
      lineNumber?: number;
      codeSnippet?: string;
    }
  ): Vulnerability {
    // Auto-enrich with OWASP/CWE for Sentinental
    const owaspCategory = OWASP_MAPPINGS[data.type];
    const cweId = CWE_MAPPINGS[data.type];
    const recommendation = RECOMMENDATIONS[data.type];

    // Build absolute path if we have workspace and file path
    let absoluteFilePath: string | undefined;
    if (context.workspacePath && data.filePath) {
      const path = require('path');
      absoluteFilePath = path.isAbsolute(data.filePath)
        ? data.filePath
        : path.join(context.workspacePath, data.filePath);
    }

    return {
      id: this.generateId(),
      taskId: context.taskId,
      sessionId: context.sessionId,
      phase: context.phase,
      timestamp: new Date(),
      ...data,
      // Sentinental fields - auto-enriched
      owaspCategory,
      cweId,
      recommendation,
      // Paths for local access (Sentinental can read directly)
      workspacePath: context.workspacePath,
      absoluteFilePath,
      storyId: context.storyId,
      iteration: context.iteration,
      // 🔥 CAUSALITY: Direct link to tool_calls table
      toolUseId: context.toolUseId,
      turnNumber: context.turnNumber,
    };
  }

  private generateId(): string {
    return `vul_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Get all vulnerabilities for a task
   */
  getVulnerabilities(taskId: string): Vulnerability[] {
    return this.vulnerabilities.get(taskId) || [];
  }

  /**
   * Get metrics for a task
   */
  getMetrics(taskId: string): SpyMetrics | null {
    return this.metrics.get(taskId) || null;
  }

  /**
   * Get summary for a task
   */
  getSummary(taskId: string): {
    vulnerabilities: Vulnerability[];
    metrics: SpyMetrics | null;
    riskScore: number;
  } {
    const vulnerabilities = this.getVulnerabilities(taskId);
    const metrics = this.getMetrics(taskId);

    // Calculate risk score (0-100)
    let riskScore = 0;
    for (const v of vulnerabilities) {
      switch (v.severity) {
        case 'critical': riskScore += 25; break;
        case 'high': riskScore += 15; break;
        case 'medium': riskScore += 5; break;
        case 'low': riskScore += 1; break;
      }
    }
    riskScore = Math.min(100, riskScore);

    return { vulnerabilities, metrics, riskScore };
  }

  /**
   * Clear data for a task
   */
  clear(taskId: string): void {
    this.vulnerabilities.delete(taskId);
    this.metrics.delete(taskId);
  }

  /**
   * Check if a vulnerability should block execution
   */
  shouldBlock(vulnerability: Vulnerability): boolean {
    return vulnerability.blocked;
  }

  // ============================================================================
  // WORKSPACE SCAN - Full codebase analysis at end of iteration
  // ============================================================================

  /**
   * Scan workspace for vulnerabilities after iteration completes
   * Called at end of each iteration: ANALYST→JUDGE→SPY or DEV→JUDGE→SPY
   *
   * @param workspacePath - Directory to scan
   * @param context - Task/session/phase context
   * @param options - Scan options (files to focus on, etc.)
   * @returns Array of vulnerabilities found (DOES NOT BLOCK)
   */
  async scanWorkspace(
    workspacePath: string,
    context: { taskId: string; sessionId: string; phase: string; storyId?: string; iteration?: number },
    options?: {
      filesToScan?: string[];
      maxFiles?: number;
      maxFileSize?: number;
    }
  ): Promise<Vulnerability[]> {
    const detected: Vulnerability[] = [];
    const fs = await import('fs');
    const path = await import('path');

    const maxFiles = options?.maxFiles ?? 100;
    const maxFileSize = options?.maxFileSize ?? 500 * 1024; // 500KB max per file
    let filesScanned = 0;

    // Ensure workspacePath is absolute
    const absoluteWorkspacePath = path.default.isAbsolute(workspacePath)
      ? workspacePath
      : path.default.resolve(workspacePath);

    console.log(`[AgentSpy] Scanning workspace: ${absoluteWorkspacePath} (phase: ${context.phase}, story: ${context.storyId || 'N/A'})`);

    // Enrich context with workspace path for Sentinental
    const enrichedContext = {
      ...context,
      workspacePath: absoluteWorkspacePath,
    };

    try {
      // Get list of files to scan
      let filesToScan = options?.filesToScan;

      if (!filesToScan || filesToScan.length === 0) {
        // Auto-detect: scan recently modified files or common code files
        filesToScan = await this.findCodeFiles(absoluteWorkspacePath, maxFiles);
      }

      for (const filePath of filesToScan) {
        if (filesScanned >= maxFiles) break;

        const fullPath = path.default.isAbsolute(filePath) ? filePath : path.default.join(absoluteWorkspacePath, filePath);

        try {
          const stat = fs.default.statSync(fullPath);
          if (!stat.isFile() || stat.size > maxFileSize) continue;

          const content = fs.default.readFileSync(fullPath, 'utf-8');
          const fileVulns = this.scanFileContent(fullPath, content, enrichedContext);
          detected.push(...fileVulns);
          filesScanned++;
        } catch {
          // File not accessible, skip
          continue;
        }
      }

      // Store vulnerabilities
      if (detected.length > 0) {
        const existing = this.vulnerabilities.get(context.taskId) || [];
        this.vulnerabilities.set(context.taskId, [...existing, ...detected]);

        // Update metrics
        const metrics = this.metrics.get(context.taskId) || {
          totalEvents: 0,
          toolCalls: 0,
          vulnerabilitiesDetected: 0,
          bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
          byType: {},
          byCategory: {},
        };

        for (const v of detected) {
          metrics.vulnerabilitiesDetected++;
          metrics.bySeverity[v.severity]++;
          metrics.byType[v.type] = (metrics.byType[v.type] || 0) + 1;
          metrics.byCategory[v.category] = (metrics.byCategory[v.category] || 0) + 1;
        }

        this.metrics.set(context.taskId, metrics);
      }

      console.log(`[AgentSpy] Workspace scan complete: ${filesScanned} files, ${detected.length} vulnerabilities found`);

    } catch (error: any) {
      console.warn(`[AgentSpy] Workspace scan error: ${error.message}`);
    }

    return detected;
  }

  /**
   * Scan a single file's content for vulnerabilities
   */
  private scanFileContent(
    filePath: string,
    content: string,
    context: { taskId: string; sessionId: string; phase: string; storyId?: string; workspacePath?: string; iteration?: number }
  ): Vulnerability[] {
    const detected: Vulnerability[] = [];
    const lines = content.split('\n');

    // 1. Scan for secrets
    for (const { pattern, severity, description } of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          detected.push(this.createVulnerability(context, {
            severity,
            type: 'secret_exposure',
            category: 'secrets',
            description: `Secret found in code: ${description}`,
            evidence: { filePath, pattern: pattern.toString() },
            toolName: 'workspace_scan',
            blocked: false, // NEVER BLOCK - just report
            matchedPattern: pattern.toString(),
            filePath,
            lineNumber: i + 1,
            codeSnippet: lines[i].slice(0, 200),
          }));
          break; // One per pattern per file
        }
      }
    }

    // 2. Scan for code injection patterns
    for (const { pattern, severity, type, description } of CODE_INJECTION_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          detected.push(this.createVulnerability(context, {
            severity,
            type,
            category: 'code_injection',
            description,
            evidence: { filePath, pattern: pattern.toString() },
            toolName: 'workspace_scan',
            blocked: false,
            matchedPattern: pattern.toString(),
            filePath,
            lineNumber: i + 1,
            codeSnippet: lines[i].slice(0, 200),
          }));
          break;
        }
      }
    }

    // 3. Scan for sensitive file paths in code
    for (const { pattern, severity, description } of SENSITIVE_PATHS) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          detected.push(this.createVulnerability(context, {
            severity,
            type: 'sensitive_file_access',
            category: 'file_system',
            description,
            evidence: { filePath, pattern: pattern.toString() },
            toolName: 'workspace_scan',
            blocked: false,
            matchedPattern: pattern.toString(),
            filePath,
            lineNumber: i + 1,
            codeSnippet: lines[i].slice(0, 200),
          }));
          break;
        }
      }
    }

    // 4. Scan for dangerous commands in scripts/config
    if (filePath.endsWith('.sh') || filePath.endsWith('.bash') || filePath.includes('package.json')) {
      for (const { pattern, severity, description } of DANGEROUS_COMMANDS) {
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            detected.push(this.createVulnerability(context, {
              severity,
              type: 'dangerous_command',
              category: 'system_destruction',
              description,
              evidence: { filePath, pattern: pattern.toString() },
              toolName: 'workspace_scan',
              blocked: false,
              matchedPattern: pattern.toString(),
              filePath,
              lineNumber: i + 1,
              codeSnippet: lines[i].slice(0, 200),
            }));
            break;
          }
        }
      }
    }

    return detected;
  }

  /**
   * Find code files in workspace
   */
  private async findCodeFiles(workspacePath: string, maxFiles: number): Promise<string[]> {
    const fs = await import('fs');
    const path = await import('path');
    const files: string[] = [];

    const codeExtensions = [
      '.ts', '.js', '.tsx', '.jsx', '.py', '.rb', '.go', '.java',
      '.sh', '.bash', '.yml', '.yaml', '.json', '.env', '.sql'
    ];

    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv'];

    const walkDir = (dir: string, depth: number = 0): void => {
      if (depth > 5 || files.length >= maxFiles) return;

      try {
        const entries = fs.default.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (files.length >= maxFiles) break;

          const fullPath = path.default.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!ignoreDirs.includes(entry.name) && !entry.name.startsWith('.')) {
              walkDir(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            const ext = path.default.extname(entry.name).toLowerCase();
            if (codeExtensions.includes(ext) || entry.name.startsWith('.env')) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        // Directory not accessible
      }
    };

    walkDir(workspacePath);
    return files;
  }

  /**
   * Get vulnerabilities for a specific story
   */
  getVulnerabilitiesByStory(taskId: string, storyId: string): Vulnerability[] {
    const all = this.vulnerabilities.get(taskId) || [];
    return all.filter(v => (v as any).storyId === storyId);
  }

  /**
   * Get vulnerabilities for a specific phase
   */
  getVulnerabilitiesByPhase(taskId: string, phase: string): Vulnerability[] {
    const all = this.vulnerabilities.get(taskId) || [];
    return all.filter(v => v.phase === phase);
  }

  // ============================================================================
  // GLOBAL SCAN - Scans ALL repositories at once
  // ============================================================================

  /**
   * Scan ALL repositories and return a GlobalVulnerabilityScan result
   * Called at the end of each phase for comprehensive security analysis
   *
   * @param repositories - Array of repositories with their paths
   * @param context - Task/session/phase context
   * @returns GlobalVulnerabilityScan with vulnerabilities grouped by repo
   */
  async scanAllRepositories(
    repositories: Array<{ name: string; localPath: string; type: string }>,
    context: { taskId: string; sessionId: string; phase: string }
  ): Promise<{
    scannedAt: Date;
    totalFilesScanned: number;
    repositoriesScanned: Array<{
      name: string;
      path: string;
      type: string;
      filesScanned: number;
      vulnerabilitiesFound: number;
    }>;
    vulnerabilities: Vulnerability[];
    bySeverity: Record<VulnerabilitySeverity, number>;
    byType: Record<string, number>;
    byRepository: Record<string, number>;
  }> {
    console.log(`[AgentSpy] Starting global scan of ${repositories.length} repositories...`);

    const scannedAt = new Date();
    let totalFilesScanned = 0;
    const allVulnerabilities: Vulnerability[] = [];
    const repositoriesScanned: Array<{
      name: string;
      path: string;
      type: string;
      filesScanned: number;
      vulnerabilitiesFound: number;
    }> = [];

    const bySeverity: Record<VulnerabilitySeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    const byType: Record<string, number> = {};
    const byRepository: Record<string, number> = {};

    for (const repo of repositories) {
      console.log(`[AgentSpy] Scanning repository: ${repo.name} (${repo.type}) at ${repo.localPath}`);

      // Scan this repository (workspacePath is the first param, context stays clean)
      const repoVulns = await this.scanWorkspace(repo.localPath, context, {
        maxFiles: 200, // More files for global scan
      });

      // Count files scanned (approximate from vulnerability count + base)
      const filesInRepo = await this.countCodeFiles(repo.localPath);
      totalFilesScanned += filesInRepo;

      repositoriesScanned.push({
        name: repo.name,
        path: repo.localPath,
        type: repo.type,
        filesScanned: filesInRepo,
        vulnerabilitiesFound: repoVulns.length,
      });

      // Tag vulnerabilities with repository name
      for (const v of repoVulns) {
        (v as any).repositoryName = repo.name;
        (v as any).repositoryType = repo.type;
        allVulnerabilities.push(v);

        // Update summaries
        bySeverity[v.severity]++;
        byType[v.type] = (byType[v.type] || 0) + 1;
        byRepository[repo.name] = (byRepository[repo.name] || 0) + 1;
      }
    }

    console.log(`[AgentSpy] Global scan complete: ${totalFilesScanned} files, ${allVulnerabilities.length} vulnerabilities across ${repositories.length} repos`);

    return {
      scannedAt,
      totalFilesScanned,
      repositoriesScanned,
      vulnerabilities: allVulnerabilities,
      bySeverity,
      byType,
      byRepository,
    };
  }

  /**
   * Count code files in a directory (for metrics)
   */
  private async countCodeFiles(workspacePath: string): Promise<number> {
    const files = await this.findCodeFiles(workspacePath, 500);
    return files.length;
  }

  /**
   * Create initial metrics object
   */
  private createInitialMetrics(): SpyMetrics {
    return {
      totalEvents: 0,
      toolCalls: 0,
      vulnerabilitiesDetected: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      byType: {},
      byCategory: {},
    };
  }

  /**
   * Register an external vulnerability (from TestGenerationPhase security edge cases)
   * This allows external phases to contribute to the Sentinental trace
   */
  registerExternalVulnerability(
    taskId: string,
    vulnerability: Omit<Vulnerability, 'id' | 'timestamp'>
  ): void {
    const fullVuln: Vulnerability = {
      ...vulnerability,
      id: `ext_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date(),
    };

    const existing = this.vulnerabilities.get(taskId) || [];
    this.vulnerabilities.set(taskId, [...existing, fullVuln]);

    // Update metrics
    const metrics = this.metrics.get(taskId) || this.createInitialMetrics();
    metrics.vulnerabilitiesDetected++;
    metrics.bySeverity[vulnerability.severity]++;
    metrics.byType[vulnerability.type] = (metrics.byType[vulnerability.type] || 0) + 1;
    metrics.byCategory[vulnerability.category] = (metrics.byCategory[vulnerability.category] || 0) + 1;
    this.metrics.set(taskId, metrics);

    console.log(`[AgentSpy] Registered external vulnerability: ${vulnerability.type} (${vulnerability.severity}) from ${vulnerability.phase}`);
  }

  /**
   * Create an empty GlobalVulnerabilityScan (for error cases)
   */
  static createEmptyGlobalScan(): {
    scannedAt: Date;
    totalFilesScanned: number;
    repositoriesScanned: never[];
    vulnerabilities: never[];
    bySeverity: Record<VulnerabilitySeverity, number>;
    byType: Record<string, number>;
    byRepository: Record<string, number>;
  } {
    return {
      scannedAt: new Date(),
      totalFilesScanned: 0,
      repositoriesScanned: [],
      vulnerabilities: [],
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      byType: {},
      byRepository: {},
    };
  }
}

export const agentSpy = new AgentSpyService();
export default agentSpy;
