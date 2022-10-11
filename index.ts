import * as dotenv from "dotenv";
import prettyBytes from 'bytes';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, Reservation, Volume } from '@aws-sdk/client-ec2'
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch'
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing'
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer'
import DineroFactory, { Dinero } from 'dinero.js'
import { DateTime } from 'luxon'
import Table from 'cli-table3';

dotenv.config({ path: __dirname + '/.env' });

const { AWS_REGION } = process.env
const credentials = {
  accessKeyId: process.env.ACCESS_KEY_ID || '',
  secretAccessKey: process.env.SECRET_ACCESS_KEY || '',
}

const cloudWatchClient = new CloudWatchClient({ credentials, region: AWS_REGION })
const ec2Client = new EC2Client({ credentials, region: AWS_REGION })
const pricingClient = new PricingClient({ credentials, region: AWS_REGION })
const costExplorerClient = new CostExplorerClient({ credentials, region: AWS_REGION })

type InstanceDescription = {
  instanceId: string,
  name: string,
  type: string,
  monthlyCost: DineroFactory.Dinero,
  peakPercentage: number,
  launchTime: Date,
  isWaste: boolean,
  storageSize: number
  storageCost: DineroFactory.Dinero,
  instanceCost: DineroFactory.Dinero,
  diskreadsPercentage: number,
  averageBytesIn: number,
  averageBytesOut: number,
}

enum Tags {
  NAME = 'Name'
}

const parsePricingInformation = (rawPricing: any): DineroFactory.Dinero => {
  const pricing = (rawPricing.PriceList || []).map((p: any) => JSON.parse(p.toString()));

  if (pricing.length !== 1) {
    throw new Error('Expected to get exactly 1 pricing info. Unable to parse into correct results.')
  }

  try {
    // @ts-ignore
    const onDemandPricing = pricing.map(item => Object.values(Object.values(item.terms.OnDemand)[0].priceDimensions)[0])[0].pricePerUnit.USD
    const [dollarComponent, centsComponent] = onDemandPricing.split('.')

    const dollars = DineroFactory({ amount: parseInt(dollarComponent), precision: 0 })
    const cents = DineroFactory({ amount: parseInt(centsComponent), precision: centsComponent.length })
  
    return dollars.add(cents)
  } catch(err) {
    const message = `Error getting pricing info: ${(err as Error).message}`;
    throw new Error(message)
  }
}

const storagePricingCache = new Map<string, DineroFactory.Dinero>()
const getStoragePricing = async (storageType: string): Promise<DineroFactory.Dinero> => {
  if (storagePricingCache.has(storageType)) {
    return storagePricingCache.get(storageType)!
  }

  const rawData = await pricingClient.send(new GetProductsCommand({
    ServiceCode: 'AmazonEC2',
    Filters: [
      { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' },
      { Type: 'TERM_MATCH', Field: 'volumeApiName', Value: storageType },
      { Type: 'TERM_MATCH', Field: 'regionCode', Value: AWS_REGION },
    ]
  }))

  const pricing = parsePricingInformation(rawData);
  instancePricingCache.set(storageType, pricing)

  return pricing;
}

const instancePricingCache = new Map<string, DineroFactory.Dinero>()
const getInstancePricing = async (instanceType: string): Promise<DineroFactory.Dinero> => {
  if (instancePricingCache.has(instanceType)) {
    return instancePricingCache.get(instanceType)!
  }

  const rawData = await pricingClient.send(new GetProductsCommand({
    ServiceCode: 'AmazonEC2',
    Filters: [
      { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Compute Instance' },
      { Type: 'TERM_MATCH', Field: 'regionCode', Value: AWS_REGION },
      { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
      { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
      { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
      { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
      { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' }
    ]
  }))

  const pricing = parsePricingInformation(rawData);
  instancePricingCache.set(instanceType, pricing)

  return pricing;
}

const THREE_PER_CENT = 3 / 100;
const MONTLHY_HOURS = 24 * 30;
const CPU_USAGE_CRITERIA = parseInt(process.env.CPU_USAGE_CRITERIA || '3') // more than X%
const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`

const getInstanceDescription = async (reservation: Reservation): Promise<InstanceDescription[]> => {
  const { Instances: instances = [] } = reservation;

  const parsedInstances: InstanceDescription[] = []

  for (const instance of instances) {
    // @ts-ignore
    process.stdout.write('.')

    const { 
      InstanceId: instanceId = '', 
      InstanceType: type = '', 
      Tags: tags = [],
      LaunchTime: launchTimeJS = new Date(),
      BlockDeviceMappings: blockDeviceMappings = [],
    } = instance;

    const nameTag = tags.find(t => t.Key === Tags.NAME)
    const name = nameTag?.Value || 'No name'

    const instancePrice = await getInstancePricing(type);
    if (!instancePrice) {
      throw new Error(`Price missing for instance type "${type}"`)
    }

    const getMetric = (statistic: string, metricName: string) => cloudWatchClient.send(
      new GetMetricStatisticsCommand({
        Statistics: [statistic],
        Dimensions: [{
          Name: 'InstanceId',
          Value: instanceId,
        }],
        MetricName: metricName,
        Namespace: 'AWS/EC2',
        Period: 60 * 10, // 10 minutes windows
        StartTime: DateTime.now().minus({ week: 1 }).toJSDate(),
        EndTime: new Date()
      })
    )

    const [
      { Datapoints: cpuDatapoints = [] }, 
      { Datapoints: diskreadsDatapoints = [] },
      { Datapoints: networkInDatapoints = [] },
      { Datapoints: networkOutDatapoints = [] },
    ] = await Promise.all([
      getMetric('Maximum', 'CPUUtilization'),
      getMetric('Maximum', 'DiskReadBytes'),
      getMetric('Average', 'NetworkIn'),
      getMetric('Average', 'NetworkOut'),
    ]);

    const averageBytesIn = networkInDatapoints.reduce((acc, datapoint) => acc + (datapoint.Average || 0), 0)
    const averageBytesOut = networkOutDatapoints.reduce((acc, datapoint) => acc + (datapoint.Average || 0), 0)

    const diskreadsMoreThanZero = diskreadsDatapoints.filter((diskReadInfo) =>
      (diskReadInfo.Maximum || 0) > 0
    ).length;

    const diskreadsPercentage = diskreadsMoreThanZero / (diskreadsDatapoints.length || 1);

    const { Volumes: volumes = [] } = await ec2Client.send(new DescribeVolumesCommand({
      VolumeIds: blockDeviceMappings
        .filter(b => !!b.Ebs && b.Ebs!.VolumeId)
        .map(b => b.Ebs!.VolumeId!)
    }))

    const storageSize = volumes.reduce((acc: number, ebs: Volume) => acc + (ebs.Size || 0), 0)
    let storageCost = DineroFactory({ amount: 0, precision: 2 })

    for (const ebs of volumes) {
      const storagePrice = await getStoragePricing(ebs.VolumeType || '')
      if (!storagePrice) {
        throw new Error(`No storage price found for volume type "${ebs.VolumeType}"`)
      }

      storageCost = storageCost.add(
        storagePrice.multiply(ebs.Size || 0)
      )
    }

    const instanceCost = instancePrice.multiply(MONTLHY_HOURS)
    const monthlyCost = instanceCost.add(storageCost)

    const peaks = cpuDatapoints.filter(point => (point.Maximum || 0) > CPU_USAGE_CRITERIA)
    const peakPercentage = peaks.length / cpuDatapoints.length

    parsedInstances.push({ 
      instanceId, 
      name, 
      type, 
      instanceCost,
      storageCost,
      monthlyCost, 
      peakPercentage,
      storageSize,
      diskreadsPercentage,
      launchTime: launchTimeJS,
      isWaste: peakPercentage < THREE_PER_CENT,
      averageBytesIn,
      averageBytesOut,
    })
  }

  return parsedInstances;
}

const getLastMonthBill = async (): Promise<DineroFactory.Dinero> => {
  const command = new GetCostAndUsageCommand({
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    TimePeriod: {
      Start: DateTime.now().toUTC().minus({ months: 1 }).startOf('month').toJSDate().toISOString().split('T')[0],
      End: DateTime.now().toUTC().startOf('month').toJSDate().toISOString().split('T')[0],
    }
  });

  const { ResultsByTime: [lastMonth] = [] } = await costExplorerClient.send(command);
  const lastAwsBill = lastMonth.Total!.UnblendedCost!.Amount!.toString()
  const [lastAwsBilDollars, lastAwsBillCents] = lastAwsBill.split('.')

  return DineroFactory({
    amount: parseInt(lastAwsBilDollars), precision: 0,
  }).add(
    DineroFactory({
      amount: parseInt(lastAwsBillCents), precision: lastAwsBillCents.length,
    })
  )
}

async function main() {  
  await getStoragePricing('gp2');

  console.log('IDLE INSTANCE IDENTIFICATOR REPORT')
  console.log('Report generation can take a few minutes, please wait...')
  console.log()

  const listInstances = new DescribeInstancesCommand({
    Filters: [{
      Name: 'instance-state-name',
      Values: ['running']
    }]
  })

  const { Reservations: reservations = [] } = await ec2Client.send(listInstances);

  let totalMonthlyCost = DineroFactory({ amount: 0, precision: 4 });
  let totalMonthlyWaste = DineroFactory({ amount: 0, precision: 4 });

  const instanceData: InstanceDescription[] = [];

  let recentlyLaunchedInstanceCount = 0;

  for (const reservation of reservations) {
    const instances = await getInstanceDescription(reservation);
    instances
      // Remove instances created in the last 3 days (perhaps they are useful dev instances)
      .filter(i => {
        const isOld = i.launchTime.valueOf() < DateTime.now().minus({ days: 3 }).toJSDate().valueOf();

        if (!isOld) {
          recentlyLaunchedInstanceCount++;
        }

        return isOld
      })
      .forEach(i => {
        totalMonthlyCost = totalMonthlyCost.add(i.monthlyCost)

        if (i.isWaste) {
          totalMonthlyWaste = totalMonthlyWaste.add(i.monthlyCost)
        }

        instanceData.push(i)
      })
  }

  instanceData.sort((a, b) => a.launchTime.valueOf() - b.launchTime.valueOf())

  const table = new Table({ head: [
    'LAUNCH DATE',
    'NAME / INSTANCE ID',
    'TYPE',
    'INSTANCE COST',
    'STORAGE',
    'NETWORKING (IN/OUT)',
    'TOTAL COST',
    'USAGE (%)',
    'IS WASTE',
  ] })

  instanceData.forEach((i) => {
    table.push([
      DateTime.fromJSDate(i.launchTime).toFormat('dd/MM/yyyy'),
      i.name + '\n' + i.instanceId,
      i.type,
      i.instanceCost.toFormat(),
      `${i.storageSize} GiB (${i.storageCost.toFormat()})`,
      `${prettyBytes(i.averageBytesIn)}/${prettyBytes(i.averageBytesOut)}`,
      i.monthlyCost.toFormat(),
      formatPercent(i.peakPercentage),
      i.isWaste
    ])
  })

  const lastAwsBill = await getLastMonthBill()
  const wastePercentage = ((totalMonthlyWaste.toUnit() / (lastAwsBill.toUnit())) * 100).toFixed(2) + '%'

  console.log()
  console.log(table.toString())
  console.log(`DEFINITION OF "USAGE": Instance had more than ${CPU_USAGE_CRITERIA}% CPU usage for more than ${THREE_PER_CENT * 100}% of the time over the last week`)
  console.log(`DEFINITION OF "NETWORK": Average number of bytes in transit on a 10 minutes window for the last week`)
  console.log()
  console.log(`TOTAL INSTANCE COUNT: ${instanceData.length} (Disregarding ${recentlyLaunchedInstanceCount} recently launched instances)`)
  console.log(`CURRENT MONTHLY COST: ${totalMonthlyCost.toFormat()}`)
  console.log(`CURRENT MONTHLY WASTE: ${totalMonthlyWaste.toFormat()} (${wastePercentage} of the last bill)`)
  console.log(`LAST AWS BILL: ${lastAwsBill.toFormat()}`)
  console.log()
}

main().catch((err) => console.log(`ERROR: ${err.message}`))
