/**
 * 功能概述：导出 Memory 图协议并声明节点与有向边的存储端口。
 * 主要职责：MemoryGraphAccess 定义有界图检视、节点及边的读写操作；updateNode 只修改存在的节点。
 * 代码库关系：协议来自 schema，PostgresMemoryGraphStore 实现接口，避免浏览器导入数据库依赖。
 * 输入输出与副作用：本入口只声明类型；具体实现执行持久化 I/O。
 */
import type {
  MemoryNode,
  MemoryNodeInput,
  MemoryNodeQuery,
  MemoryEdge,
  MemoryEdgeInput,
  MemoryEdgeQuery,
  MemoryGraphQuery,
  MemoryGraphSnapshot,
} from "@kaguya/schema";
export {
  memoryNodeIdSchema,
  memoryNodeMetadataSchema,
  memoryNodeInputSchema,
  memoryNodeSchema,
  memoryEdgeInputSchema,
  memoryNodeQuerySchema,
  memoryEdgeQuerySchema,
  memoryGraphQuerySchema,
  memoryGraphSnapshotSchema,
  type MemoryNode,
  type MemoryNodeInput,
  type MemoryNodeQuery,
  type MemoryEdge,
  type MemoryEdgeInput,
  type MemoryEdgeQuery,
  type MemoryGraphQuery,
  type MemoryGraphSnapshot,
} from "@kaguya/schema";

export interface MemoryGraphAccess {
  readGraph(query?: MemoryGraphQuery): Promise<MemoryGraphSnapshot>;
  putNode(input: MemoryNodeInput): Promise<MemoryNode>;
  updateNode(
    input: MemoryNodeInput & { id: string },
  ): Promise<MemoryNode | undefined>;
  getNode(id: string): Promise<MemoryNode | undefined>;
  listNodes(query?: MemoryNodeQuery): Promise<readonly MemoryNode[]>;
  deleteNode(id: string): Promise<boolean>;
  putEdge(input: MemoryEdgeInput): Promise<MemoryEdge>;
  listEdges(query: MemoryEdgeQuery): Promise<readonly MemoryEdge[]>;
  deleteEdge(
    sourceId: string,
    targetId: string,
    relation: string,
  ): Promise<boolean>;
}
