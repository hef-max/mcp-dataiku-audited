# Dataiku MCP Server - API 功能实现清单

基于 dataiku_factory Python 项目的功能分析，列出所有需要实现的 API 接口和功能。

## 📋 核心功能分类

### 1. 项目管理 (Project Management)
- [x] `list_projects` - 列出所有项目
- [x] `get_project_info` - 获取项目详细信息
- [x] `get_project_flow` - 获取项目数据流结构
- [x] `export_project_config` - 导出项目配置
- [x] `duplicate_project_structure` - 复制项目结构

### 2. 数据集管理 (Dataset Management)
- [x] `create_dataset` - 创建数据集
- [x] `update_dataset` - 更新数据集
- [x] `delete_dataset` - 删除数据集
- [x] `build_dataset` - 构建数据集
- [x] `inspect_dataset_schema` - 查看数据集架构
- [x] `check_dataset_metrics` - 检查数据集指标
- [x] `list_datasets` - 列出所有数据集
- [x] `get_dataset_info` - 获取数据集详细信息
- [x] `clear_dataset` - 清空数据集数据
- [x] `get_dataset_sample` - 获取数据集样本数据

### 3. 配方管理 (Recipe Management)
- [x] `create_recipe` - 创建配方
- [x] `update_recipe` - 更新配方
- [x] `delete_recipe` - 删除配方
- [x] `run_recipe` - 运行配方
- [x] `get_recipe_info` - 获取配方详细信息
- [x] `list_recipes` - 列出所有配方
- [x] `get_recipe_code` - 获取配方代码
- [x] `validate_recipe_syntax` - 验证配方语法
- [x] `test_recipe_dry_run` - 测试配方逻辑

### 4. 场景管理 (Scenario Management)
- [x] `create_scenario` - 创建场景
- [x] `update_scenario` - 更新场景
- [x] `delete_scenario` - 删除场景
- [x] `run_scenario` - 运行场景
- [x] `add_scenario_trigger` - 添加场景触发器
- [x] `remove_scenario_trigger` - 移除场景触发器
- [x] `get_scenario_info` - 获取场景详细信息
- [x] `list_scenarios` - 列出所有场景
- [x] `get_scenario_run_history` - 获取场景运行历史

### 5. 高级场景功能 (Advanced Scenario Features)
- [x] `get_scenario_logs` - 获取场景运行日志
- [x] `get_scenario_steps` - 获取场景步骤详情
- [x] `clone_scenario` - 克隆场景

### 6. 代码开发工具 (Code Development Tools)
- [x] `validate_recipe_syntax` - 验证配方语法
- [x] `test_recipe_dry_run` - 测试配方干运行

### 7. 项目探索工具 (Project Exploration Tools)
- [x] `get_project_flow` - 获取项目数据流
- [x] `search_project_objects` - 搜索项目对象
- [x] `get_dataset_sample` - 获取数据集样本

### 8. 环境配置工具 (Environment Configuration)
- [x] `get_code_environments` - 获取代码环境
- [x] `get_project_variables` - 获取项目变量
- [x] `get_connections` - 获取数据连接

### 9. 监控调试工具 (Monitoring & Debugging)
- [x] `get_recent_runs` - 获取最近运行历史
- [x] `get_job_details` - 获取作业详情
- [x] `cancel_running_jobs` - 取消运行中的作业

### 10. 生产力工具 (Productivity Tools)
- [x] `batch_update_objects` - 批量更新对象

## 🔧 API 接口详情

### 项目管理 API
```typescript
// 列出所有项目
listProjects(): Promise<Array<{key: string, name: string, description?: string}>>

// 获取项目信息
getProject(projectKey: string): Promise<any>

// 获取项目数据流
getProjectFlow(projectKey: string): Promise<any>

// 导出项目配置
exportProjectConfig(projectKey: string, format: 'json' | 'yaml'): Promise<any>

// 复制项目结构
duplicateProjectStructure(sourceProjectKey: string, targetProjectKey: string, includeData: boolean): Promise<any>
```

### 数据集管理 API
```typescript
// 列出数据集
listDatasets(projectKey: string): Promise<any[]>

// 获取数据集信息
getDatasetInfo(projectKey: string, datasetName: string): Promise<any>

// 清空数据集
clearDataset(projectKey: string, datasetName: string, partition?: string): Promise<any>

// 获取数据集样本
getDatasetSample(projectKey: string, datasetName: string, rows: number, columns?: string[]): Promise<any>
```

### 配方管理 API
```typescript
// 列出配方
listRecipes(projectKey: string): Promise<any[]>

// 获取配方信息
getRecipeInfo(projectKey: string, recipeName: string): Promise<any>

// 验证配方语法
validateRecipeSyntax(projectKey: string, recipeName: string, code?: string): Promise<any>

// 测试配方干运行
testRecipeDryRun(projectKey: string, recipeName: string, sampleRows: number): Promise<any>
```

### 场景管理 API
```typescript
// 列出场景
listScenarios(projectKey: string, scenarioType?: string, activeOnly?: boolean): Promise<any[]>

// 获取场景信息
getScenarioInfo(projectKey: string, scenarioId: string): Promise<any>

// 添加场景触发器
addScenarioTrigger(
  projectKey: string,
  scenarioId: string,
  triggerType: 'periodic' | 'hourly' | 'daily' | 'monthly' | 'dataset',
  params: Record<string, any>
): Promise<any>

// 移除场景触发器
removeScenarioTrigger(projectKey: string, scenarioId: string, triggerIdx: number): Promise<any>

// 获取场景运行历史
getScenarioRunHistory(projectKey: string, scenarioId: string, limit?: number): Promise<any>
```

### 高级功能 API
```typescript
// 获取场景步骤
getScenarioSteps(projectKey: string, scenarioId: string): Promise<any>

// 克隆场景
cloneScenario(
  projectKey: string,
  sourceScenarioId: string,
  newScenarioName: string,
  modifications?: Record<string, any>
): Promise<any>

// 搜索项目对象
searchProjectObjects(
  projectKey: string,
  searchTerm: string,
  objectTypes?: string[]
): Promise<any[]>

// 获取代码环境
getCodeEnvironments(projectKey?: string): Promise<any[]>

// 获取项目变量
getProjectVariables(projectKey: string): Promise<any>

// 获取数据连接
getConnections(projectKey?: string): Promise<any[]>

// 获取作业详情
getJobDetails(projectKey: string, jobId: string): Promise<any>

// 取消运行中的作业
cancelRunningJobs(projectKey: string, jobIds: string[]): Promise<any>

// 批量更新对象
batchUpdateObjects(
  projectKey: string,
  objectType: string,
  pattern: string,
  updates: Record<string, any>
): Promise<any>
```

## ✅ 实现状态总结

**全部46个API接口已完整实现！** 🎉

- ✅ **高优先级 (必须实现)** - 100% 完成
- ✅ **中优先级 (建议实现)** - 100% 完成
- ✅ **低优先级 (可选实现)** - 100% 完成

## 🎯 实现优先级

### 高优先级 (必须实现)
1. 基础 CRUD 操作 (已完成部分)
2. 项目列表和基本信息
3. 数据集列表和详细信息
4. 配方列表和详细信息
5. 场景列表和详细信息

### 中优先级 (建议实现)
1. 高级查询和搜索功能
2. 数据样本获取
3. 场景触发器管理
4. 运行历史和日志

### 低优先级 (可选实现)
1. 批量操作
2. 项目配置导出
3. 代码语法验证
4. 干运行测试

## 📝 注意事项

1. **环境变量配置**: 所有 API 密钥和主机信息都应通过环境变量配置
2. **错误处理**: 需要完善的错误处理和用户友好的错误消息
3. **类型安全**: TypeScript 类型定义需要准确反映 API 响应结构
4. **性能优化**: 考虑实现缓存机制以提高响应速度
5. **安全考虑**: 确保不暴露敏感信息在错误消息中

## 🔗 参考实现

- Python 参考项目: `/Users/steven0lisa/work/playground/dataiku_factory`
- Node.js 类型定义: 参考 `src/dataiku-client.ts`
- MCP 服务器实现: 参考 `src/mcp-server.ts`