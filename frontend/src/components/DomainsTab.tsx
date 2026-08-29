import { useCallback, useEffect, useState } from 'react'
import { Box, Typography, Tabs, Tab, Alert, CircularProgress } from '@mui/material'
import { motion } from 'framer-motion'
import { coordinatorGet, ApiError } from '../api'
import DomainRegistryPanel from './DomainRegistryPanel'
import DomainAssignmentsPanel from './DomainAssignmentsPanel'

// Domains maps custom domains to apps. Preserves the console Domains.js
// contract exactly: platform-wide domains list when no project is selected,
// project-scoped domains + assignments otherwise. Split into a shell (this
// file, owns fetching/state) + two panels (registry / assignments) since the
// original console page was 771 LOC in one file.

export interface Domain {
  id?: string
  domain: string
  dnsMethod?: string
  isPlatformDomain?: boolean
  status?: string
  createdOn?: string
  [key: string]: unknown
}

export interface DomainAssignment {
  id?: string
  fqdn?: string
  subdomain?: string
  domainName?: string
  appName?: string
  status?: string
  createdOn?: string
  [key: string]: unknown
}

// NOTE: admin doesn't yet have a per-project "current group" selector the
// way console did (currentGroup.projectId). Until that selector lands here,
// this tab always renders the platform-wide domains view (no projectId) —
// project-scoped register/assign actions are disabled accordingly. This
// mirrors what console showed to a SYSTEM user with no project selected.
const PROJECT_ID: string | null = null

export default function DomainsTab() {
  const [tab, setTab] = useState(0)
  const [domains, setDomains] = useState<Domain[]>([])
  const [assignments, setAssignments] = useState<DomainAssignment[]>([])
  const [platformDomains, setPlatformDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const fetchAll = useCallback(() => {
    setErr(null)
    // Admin view (no PROJECT_ID) now fetches EVERY domain cross-tenant via the
    // new /admin endpoint (coord #214) — previously it only saw the 2 rows
    // flagged is_platform_domain=true, missing 6 project-scoped custom zones.
    // The Domain record carries isPlatformDomain so DomainRegistryPanel can
    // render a Platform badge for the ones tagged as such.
    const domainsPromise = PROJECT_ID
      ? coordinatorGet<Domain[]>(`/api/domains/?projectId=${PROJECT_ID}`)
      : coordinatorGet<Domain[]>('/api/domains/admin')
    const assignmentsPromise = PROJECT_ID
      ? coordinatorGet<DomainAssignment[]>(`/api/domains/assignments?projectId=${PROJECT_ID}`)
      : Promise.resolve<DomainAssignment[]>([])

    return Promise.all([
      domainsPromise,
      assignmentsPromise,
      coordinatorGet<Domain[]>('/api/domains/platform'),
    ])
      .then(([d, a, p]) => {
        setDomains(d)
        setAssignments(a)
        setPlatformDomains(p)
      })
      .catch((e: ApiError) => setErr(`Failed to load domains: ${e.message}`))
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchAll().finally(() => setLoading(false))
  }, [fetchAll])

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
      <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
        <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
          Domains
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Map custom domains to apps.
        </Typography>

        {err && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr(null)}>
            {err}
          </Alert>
        )}

        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{ mb: 2 }}
        >
          <Tab label="Domains" />
          <Tab label="Assignments" />
        </Tabs>

        {loading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 4 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              Loading domains…
            </Typography>
          </Box>
        ) : tab === 0 ? (
          <DomainRegistryPanel domains={domains} projectId={PROJECT_ID} onRefresh={fetchAll} setErr={setErr} />
        ) : (
          <DomainAssignmentsPanel
            assignments={assignments}
            domains={domains}
            platformDomains={platformDomains}
            projectId={PROJECT_ID}
            onRefresh={fetchAll}
            setErr={setErr}
          />
        )}
      </Box>
    </motion.div>
  )
}
