// This is where the main agent loop lives 

async function runAgent(userMessage: string):

    while (true){
        const response = await llm.call(message, tools);
        message.push(response);

        if (response.stopReason == "end_turn") return response;

        if (response.stopReason == "tool_use"){
            const toolResults = await executeTools(response.toolCalls)
            message.push({role: "user", content toolResults})
        }

}
