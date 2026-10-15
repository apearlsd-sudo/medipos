const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient();
(async()=>{
  const settings=await db.storeSetting.findMany({orderBy:{key:'asc'},select:{key:true,value:true}});
  console.log('SETTINGS:', JSON.stringify(settings));
  const cols=await db.$queryRawUnsafe("PRAGMA table_info('Sale')");
  console.log('SALE_COLS:', cols.map(c=>c.name).join(','));
  const cnt=await db.sale.count();
  const latest=await db.sale.findFirst({orderBy:{createdAt:'desc'},select:{invoiceNo:true,createdAt:true,tax:true}});
  console.log('SALES:', cnt, 'LATEST:', JSON.stringify(latest));
  const users=await db.user.findMany({select:{id:true,name:true,username:true,role:true,status:true}});
  console.log('USERS:', JSON.stringify(users));
  const roles=await db.role.findMany({select:{id:true,name:true,slug:true,permissions:true}});
  console.log('ROLES:', JSON.stringify(roles.map(r=>({name:r.name,slug:r.slug,permCount:(r.permissions||[]).length,hasSalesView:(r.permissions||[]).includes('sales:view'),hasSalesViewOwn:(r.permissions||[]).includes('sales:view_own')}))));
  await db.$disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
