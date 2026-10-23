// Sample documents for the keyless demo; played back as if extracted live.
export const DEMO_CHUNKS = [
  { text: "Apple was founded in 1976 by Steve Jobs and Steve Wozniak in Cupertino. Tim Cook became CEO in 2011.",
    nodes: [["Apple", "Company"], ["Steve Jobs", "Person"], ["Steve Wozniak", "Person"], ["Cupertino", "Location"], ["Tim Cook", "Person"]],
    links: [["Steve Jobs", "FOUNDED", "Apple"], ["Steve Wozniak", "FOUNDED", "Apple"], ["Apple", "HEADQUARTERED_IN", "Cupertino"], ["Tim Cook", "CEO_OF", "Apple"]] },
  { text: "Apple designs the iPhone, the Mac and the Vision Pro. Its chips are manufactured by TSMC.",
    nodes: [["iPhone", "Product"], ["Mac", "Product"], ["Vision Pro", "Product"], ["TSMC", "Company"]],
    links: [["Apple", "MAKES", "iPhone"], ["Apple", "MAKES", "Mac"], ["Apple", "MAKES", "Vision Pro"], ["TSMC", "MANUFACTURES_FOR", "Apple"]] },
  { text: "Microsoft was founded by Bill Gates and Paul Allen in Redmond. Satya Nadella is CEO. It owns Windows, Azure and GitHub.",
    nodes: [["Microsoft", "Company"], ["Bill Gates", "Person"], ["Paul Allen", "Person"], ["Redmond", "Location"], ["Satya Nadella", "Person"], ["Windows", "Product"], ["Azure", "Product"], ["GitHub", "Product"]],
    links: [["Bill Gates", "FOUNDED", "Microsoft"], ["Paul Allen", "FOUNDED", "Microsoft"], ["Microsoft", "HEADQUARTERED_IN", "Redmond"], ["Satya Nadella", "CEO_OF", "Microsoft"], ["Microsoft", "MAKES", "Windows"], ["Microsoft", "MAKES", "Azure"], ["Microsoft", "OWNS", "GitHub"], ["Apple", "COMPETES_WITH", "Microsoft"]] },
  { text: "OpenAI, led by Sam Altman in San Francisco, created ChatGPT. Microsoft invested in OpenAI, whose models run on Azure.",
    nodes: [["OpenAI", "Company"], ["Sam Altman", "Person"], ["San Francisco", "Location"], ["ChatGPT", "Product"]],
    links: [["Sam Altman", "CEO_OF", "OpenAI"], ["OpenAI", "HEADQUARTERED_IN", "San Francisco"], ["OpenAI", "MAKES", "ChatGPT"], ["Microsoft", "INVESTED_IN", "OpenAI"], ["ChatGPT", "RUNS_ON", "Azure"]] },
  { text: "Nvidia, run by Jensen Huang, designs the H100 GPU that OpenAI trains on. TSMC manufactures Nvidia's chips.",
    nodes: [["Nvidia", "Company"], ["Jensen Huang", "Person"], ["H100", "Product"], ["Santa Clara", "Location"]],
    links: [["Jensen Huang", "CEO_OF", "Nvidia"], ["Nvidia", "MAKES", "H100"], ["Nvidia", "HEADQUARTERED_IN", "Santa Clara"], ["OpenAI", "USES", "H100"], ["TSMC", "MANUFACTURES_FOR", "Nvidia"]] },
  { text: "Google, a subsidiary of Alphabet, is led by Sundar Pichai. It built Gemini and Android, and acquired DeepMind in 2014.",
    nodes: [["Google", "Company"], ["Alphabet", "Company"], ["Sundar Pichai", "Person"], ["Gemini", "Product"], ["Android", "Product"], ["DeepMind", "Company"], ["Mountain View", "Location"]],
    links: [["Alphabet", "OWNS", "Google"], ["Sundar Pichai", "CEO_OF", "Google"], ["Google", "MAKES", "Gemini"], ["Google", "MAKES", "Android"], ["Google", "ACQUIRED", "DeepMind"], ["Google", "HEADQUARTERED_IN", "Mountain View"], ["Google", "COMPETES_WITH", "OpenAI"], ["Android", "COMPETES_WITH", "iPhone"]] },
];

// Convert tuples to the same shape the backend streams.
export const toEvent = (c) => ({
  text: c.text,
  nodes: c.nodes.map(([name, label]) => ({ id: name, name, label })),
  links: c.links.map(([source, type, target]) => ({ source, type, target })),
});
