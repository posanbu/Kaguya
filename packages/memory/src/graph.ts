/** Memory 图读取端口与共享协议。版本发布由 NativeMemoryStore 负责。 */
/** Memory 图读取端口与共享协议。版本发布由 NativeMemoryStore 负责。 */
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
  getNode(id: string): Promise<MemoryNode | undefined>;
  listNodes(query?: MemoryNodeQuery): Promise<readonly MemoryNode[]>;
  listEdges(query: MemoryEdgeQuery): Promise<readonly MemoryEdge[]>;
}
