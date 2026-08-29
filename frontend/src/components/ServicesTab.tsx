import { useState, useEffect } from 'react'
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  CircularProgress,
  Alert,
} from '@mui/material'
import { motion } from 'framer-motion'
import StorageIcon from '@mui/icons-material/Storage'
import AttachMoneyIcon from '@mui/icons-material/AttachMoney'
import { apiFetch } from '../api'

interface Service {
  name: string
  cost: number
  status: string
}

interface Resource {
  service: string
  count: number
}

const serviceIcons: Record<string, string> = {
  'Amazon Elastic Compute Cloud - Compute': 'EC2',
  'Amazon Elastic Container Service for Kubernetes': 'EKS',
  'Amazon Simple Storage Service': 'S3',
  'Amazon Relational Database Service': 'RDS',
  'Amazon Elastic Load Balancing': 'ELB',
  'Amazon Virtual Private Cloud': 'VPC',
  'EC2 - Other': 'EC2 Other',
  'Amazon EC2 Container Registry (ECR)': 'ECR',
  'Amazon Lightsail': 'Lightsail',
  'Amazon Route 53': 'Route53',
  'AmazonCloudWatch': 'CloudWatch',
  'Amazon Elastic File System': 'EFS',
}

// Services that can navigate to specific sub-tabs within the AWS section.
// Paths match the left-nav path model in AppShell / Sidebar.
const navigablePaths: Record<string, string> = {
  'EC2': 'infra/aws/compute',
  'EC2 Other': 'infra/aws/compute',
  'EKS': 'infra/aws/clusters',
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
}

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
}

interface ServicesTabProps {
  onNavigateToTab?: (path: string) => void
}

function ServicesTab({ onNavigateToTab }: ServicesTabProps) {
  const [services, setServices] = useState<Service[]>([])
  const [resources, setResources] = useState<Resource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [servicesRes, resourcesRes] = await Promise.all([
          apiFetch('/api/services'),
          apiFetch('/api/resources'),
        ])

        const servicesData = await servicesRes.json()
        const resourcesData = await resourcesRes.json()

        if (servicesData.error) throw new Error(servicesData.error)
        if (resourcesData.error) throw new Error(resourcesData.error)

        setServices(servicesData.services)
        setResources(resourcesData.resources)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>
  }

  const totalCost = services.reduce((sum, s) => sum + Number(s.cost ?? 0), 0)

  return (
    <Box>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Card sx={{ mb: 3, bgcolor: 'primary.main', color: 'white' }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <AttachMoneyIcon sx={{ fontSize: 40 }} />
              <Box>
                <Typography variant="h4" fontWeight="bold">
                  ${totalCost.toFixed(2)}
                </Typography>
                <Typography variant="body2" sx={{ opacity: 0.8 }}>
                  Total cost (last 30 days)
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </motion.div>

      <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
        Active Services ({services.length})
      </Typography>

      <motion.div variants={container} initial="hidden" animate="show">
        <Grid container spacing={2}>
          {services.map((service) => (
            <Grid item xs={12} sm={6} md={4} lg={3} key={service.name}>
              <motion.div variants={item}>
                {(() => {
                  const serviceLabel = serviceIcons[service.name] || 'AWS'
                  const isNavigable = serviceLabel in navigablePaths

                  return (
                    <Card
                      sx={{
                        height: '100%',
                        transition: 'transform 0.2s, box-shadow 0.2s',
                        cursor: isNavigable ? 'pointer' : 'default',
                        border: isNavigable ? '2px solid' : undefined,
                        borderColor: isNavigable ? 'primary.main' : undefined,
                        '&:hover': {
                          transform: 'translateY(-4px)',
                          boxShadow: 4,
                        },
                      }}
                      onClick={() => {
                        if (isNavigable && onNavigateToTab) {
                          onNavigateToTab(navigablePaths[serviceLabel])
                        }
                      }}
                    >
                      <CardContent>
                        <Box
                          sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            mb: 1,
                          }}
                        >
                          <Chip
                            label={serviceLabel}
                            size="small"
                            color={isNavigable ? 'primary' : 'secondary'}
                            sx={{ fontWeight: 600 }}
                          />
                          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                            <Chip
                              label={`$${Number(service.cost ?? 0).toFixed(2)}`}
                              size="small"
                              variant="outlined"
                            />
                            {isNavigable && (
                              <Chip
                                label="→"
                                size="small"
                                color="primary"
                                variant="outlined"
                                sx={{ minWidth: 28 }}
                              />
                            )}
                          </Box>
                        </Box>
                        <Typography
                          variant="body2"
                          sx={{
                            fontWeight: 500,
                            mt: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                          }}
                        >
                          {service.name}
                        </Typography>
                        {isNavigable && (
                          <Typography variant="caption" color="primary" sx={{ mt: 0.5, display: 'block' }}>
                            Click to view clusters
                          </Typography>
                        )}
                      </CardContent>
                    </Card>
                  )
                })()}
              </motion.div>
            </Grid>
          ))}
        </Grid>
      </motion.div>

      <Typography variant="h6" sx={{ mt: 4, mb: 2, fontWeight: 600 }}>
        Resources by Service
      </Typography>

      <motion.div variants={container} initial="hidden" animate="show">
        <Grid container spacing={2}>
          {resources.map((resource) => (
            <Grid item xs={6} sm={4} md={3} lg={2} key={resource.service}>
              <motion.div variants={item}>
                <Card sx={{ textAlign: 'center' }}>
                  <CardContent>
                    <StorageIcon color="primary" sx={{ fontSize: 32, mb: 1 }} />
                    <Typography variant="h5" fontWeight="bold">
                      {resource.count}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ textTransform: 'uppercase' }}
                    >
                      {resource.service}
                    </Typography>
                  </CardContent>
                </Card>
              </motion.div>
            </Grid>
          ))}
        </Grid>
      </motion.div>
    </Box>
  )
}

export default ServicesTab
