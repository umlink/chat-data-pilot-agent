/** 数据源类型与连接配置表单字段定义（镜像 backend/app/schemas/datasource.py）。 */

export type DatasourceType =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'csv'
  | 'excel'
  | 'json'

export const DATASOURCE_TYPE_OPTIONS: Array<{ value: DatasourceType; label: string }> = [
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'csv', label: 'CSV' },
  { value: 'excel', label: 'Excel' },
  { value: 'json', label: 'JSON' },
]

/** 文件型数据源：不建立数据库连接，通过聊天区附件上传导入 */
export const FILE_TYPES: DatasourceType[] = ['csv', 'excel', 'json']

export function isFileType(type: string): boolean {
  return FILE_TYPES.includes(type as DatasourceType)
}

export function datasourceTypeLabel(type: string): string {
  return DATASOURCE_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type
}

/** POST /api/datasources/test 返回 */
export interface TestResult {
  ok: boolean
  server_version?: string
  error?: string
}

export interface ConfigFieldDef {
  name: string
  label: string
  /** text 缺省；password 为敏感字段（后端加密存储/出参掩码） */
  type?: 'text' | 'number' | 'password' | 'select'
  placeholder?: string
  required?: boolean
  defaultValue?: string
  options?: Array<{ value: string; label: string }>
}

const SSL_OPTIONS = [
  { value: 'false', label: '不启用' },
  { value: 'true', label: '启用' },
]

export const CONFIG_FIELDS: Record<DatasourceType, ConfigFieldDef[]> = {
  postgresql: [
    { name: 'host', label: '主机', required: true, placeholder: 'localhost' },
    { name: 'port', label: '端口', type: 'number', defaultValue: '5432', placeholder: '5432' },
    { name: 'database', label: '数据库名', required: true, placeholder: 'postgres' },
    { name: 'user', label: '用户名', required: true, placeholder: 'postgres' },
    { name: 'password', label: '密码', type: 'password' },
    { name: 'ssl', label: 'SSL', type: 'select', defaultValue: 'false', options: SSL_OPTIONS },
    {
      name: 'dsn',
      label: 'DSN / URL（可选）',
      placeholder: 'postgresql://user:pass@host:5432/db，留空则使用上方字段',
    },
  ],
  mysql: [
    { name: 'host', label: '主机', required: true, placeholder: 'localhost' },
    { name: 'port', label: '端口', type: 'number', defaultValue: '3306', placeholder: '3306' },
    { name: 'database', label: '数据库名', required: true, placeholder: 'mysql' },
    { name: 'user', label: '用户名', required: true, placeholder: 'root' },
    { name: 'password', label: '密码', type: 'password' },
    { name: 'ssl', label: 'SSL', type: 'select', defaultValue: 'false', options: SSL_OPTIONS },
  ],
  sqlite: [
    { name: 'path', label: '文件路径', required: true, placeholder: '/data/app.db' },
    { name: 'username', label: '用户名（可选）' },
    { name: 'password', label: '密码（可选）', type: 'password' },
  ],
  csv: [],
  excel: [],
  json: [],
}
