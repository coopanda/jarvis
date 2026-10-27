// Server-only Groq transport. Never log credentials, prompts or provider bodies.
export const GROQ_CHAT_URL='https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODELS_URL='https://api.groq.com/openai/v1/models';
export const GROQ_DEFAULT_MODEL='llama-3.1-8b-instant';
const alternatives=['llama-3.3-70b-versatile','openai/gpt-oss-20b','openai/gpt-oss-120b'];
const safeCodes=new Set(['model_not_found','model_decommissioned','invalid_api_key','rate_limit_exceeded','insufficient_quota']);
export function createGroqClient({key,model=GROQ_DEFAULT_MODEL,fetchImpl=globalThis.fetch,log=()=>{}}={}){
  let active=String(model||GROQ_DEFAULT_MODEL).trim()||GROQ_DEFAULT_MODEL;
  async function request(url,body,signal){
    if(!key)throw Object.assign(new Error('Groq is not configured. Set GROQ_API_KEY in Render.'),{status:503});
    const headers={Authorization:'Bearer '+key,Accept:'application/json'};
    if(body)headers['Content-Type']='application/json';
    let response;
    try{response=await fetchImpl(url,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});}
    catch(error){if(error.name==='AbortError')throw error;throw Object.assign(new Error('Groq connection timed out or failed. Retry shortly.'),{status:502});}
    const data=await response.json().catch(()=>null);
    if(!response.ok){
      const code=safeCodes.has(data?.error?.code)?data.error.code:null;
      log({event:'groq_provider_error',providerStatus:response.status,code});
      const message=response.status===401?'Groq rejected its server API key. Review GROQ_API_KEY in Render.':response.status===429?'Groq rate limit reached. Retry shortly.':`Groq request failed (HTTP ${response.status}${code?'; '+code:''}). Review server model configuration.`;
      throw Object.assign(new Error(message),{status:response.status===429?429:502,providerStatus:response.status,providerCode:code});
    }
    if(!data)throw Object.assign(new Error('Groq returned an invalid response.'),{status:502});
    return data;
  }
  async function discover(exclude){
    const data=await request(GROQ_MODELS_URL);
    const available=new Set((data.data||[]).filter(x=>x.active!==false).map(x=>x.id));
    const next=[active,GROQ_DEFAULT_MODEL,...alternatives].find(id=>id!==exclude&&available.has(id));
    if(!next)throw Object.assign(new Error('No supported Groq chat model is available to this API key. Review GROQ_MODEL in Render.'),{status:503});
    if(next!==active)log({event:'groq_model_fallback',from:active,model:next});
    active=next;return active;
  }
  async function complete(messages,{signal,maxTokens=2400}={}){
    const send=()=>request(GROQ_CHAT_URL,{model:active,max_completion_tokens:maxTokens,messages},signal);
    let data;
    try{data=await send();}
    catch(error){
      if(error.providerStatus!==404&&error.providerCode!=='model_decommissioned'&&error.providerCode!=='model_not_found')throw error;
      await discover(active);data=await send();
    }
    const reply=data.choices?.[0]?.message?.content;
    if(typeof reply!=='string'||!reply.trim())throw Object.assign(new Error('Groq returned no readable answer.'),{status:502});
    return reply;
  }
  // Deployment diagnostic uses a fixed, non-user prompt; it does not unlock sessions or invoke tools.
  async function verify(){
    await discover();
    await complete([{role:'user',content:'Reply with OK only.'}],{maxTokens:32});
    log({event:'groq_chat_verified',model:active,endpoint:GROQ_CHAT_URL});
    return active;
  }
  return {complete,verify};
}
