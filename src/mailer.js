
let transporterPromise=null;
async function getTransporter(){
  if(!process.env.SMTP_HOST)return null;
  if(!transporterPromise){
    transporterPromise=import('nodemailer').then(({default:nodemailer})=>nodemailer.createTransport({
      host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT)||587,
      secure:Number(process.env.SMTP_PORT)===465,
      auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined
    }));
  }
  return transporterPromise;
}
export async function sendMail({to,subject,text,html}){
  const transporter=await getTransporter();
  if(!transporter){console.log(`[mailer:simulated] to=${to} subject="${subject}"`);return {simulated:true}}
  await transporter.sendMail({from:process.env.MAIL_FROM||'ServeQR <no-reply@serveqr.demo>',to,subject,text,html});
  return {simulated:false};
}
