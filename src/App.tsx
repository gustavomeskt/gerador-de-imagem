import { Background, Panel, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import FlowHeader from './components/FlowHeader'
import Home from './components/Home'
import NodeDock from './components/NodeDock'
import StorageBanner from './components/StorageBanner'
import ImageNode from './nodes/ImageNode'
import PromptNode from './nodes/PromptNode'
import { FlowIdContext } from './store/flowIdContext'
import { useFlowStore } from './store/useFlowStore'
import './index.css'

const nodeTypes = { prompt: PromptNode, image: ImageNode }

function FlowCanvas({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  const nodes = useFlowStore((s) => s.flowsData[flowId]?.nodes ?? [])
  const edges = useFlowStore((s) => s.flowsData[flowId]?.edges ?? [])
  const onNodesChange = useFlowStore((s) => s.onNodesChange)
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange)
  const onConnect = useFlowStore((s) => s.onConnect)

  const defaultEdgeOptions = useMemo(() => ({ style: { strokeWidth: 2 } }), [])

  return (
    <FlowIdContext.Provider value={flowId}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={(changes) => onNodesChange(flowId, changes)}
        onEdgesChange={(changes) => onEdgesChange(flowId, changes)}
        onConnect={(connection) => onConnect(flowId, connection)}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        minZoom={0.2}
      >
        <Background color="#222228" />
        <NodeDock />
        <Panel position="top-left">
          <FlowHeader flowId={flowId} onBack={onBack} />
        </Panel>
      </ReactFlow>
    </FlowIdContext.Provider>
  )
}

function FlowRoute() {
  const { id } = useParams<{ id: string }>()
  const flows = useFlowStore((s) => s.flows)
  const navigate = useNavigate()

  const exists = !!id && flows.some((f) => f.id === id)
  if (!id || !exists) return <Navigate to="/" replace />

  return (
    <ReactFlowProvider>
      <FlowCanvas flowId={id} onBack={() => navigate('/')} />
    </ReactFlowProvider>
  )
}

function HomeRoute() {
  const navigate = useNavigate()
  return <Home onOpenFlow={(id) => navigate(`/flow/${id}`)} />
}

export default function App() {
  const hydrated = useFlowStore((s) => s.hydrated)
  const hydrate = useFlowStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (!hydrated) {
    return (
      <div className="ifs-app ifs-loading">
        <span>Carregando projetos salvos…</span>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <div className="ifs-app">
        <StorageBanner />
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/flow/:id" element={<FlowRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
